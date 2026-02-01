import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { createWriteStream } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import archiver from "archiver";

import { getWecomRuntime } from "./runtime.js";
import { listWecomAccountIds } from "./accounts.js";
import { sendWecomFile, sendWecomText, uploadWecomMedia } from "./wecom-api.js";
import type { ResolvedWecomAccount } from "./types.js";

export type CommandContext = {
  account: ResolvedWecomAccount;
  fromUser: string;
  chatId?: string;
  isGroup: boolean;
  cfg: ClawdbotConfig;
  log?: (message: string) => void;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
};

async function sendAndRecord(ctx: CommandContext, text: string): Promise<void> {
  await sendWecomText({ account: ctx.account, toUser: ctx.fromUser, chatId: ctx.isGroup ? ctx.chatId : undefined, text });
  ctx.statusSink?.({ lastOutboundAt: Date.now() });
  ctx.log?.(`[wecom] command reply sent to ${ctx.fromUser}`);
}

function parseQuotedArgs(raw: string): string[] {
  const args: string[] = [];
  const normalized = raw.replace(/,/g, " ");
  const regex = /"([^"]+)"|'([^']+)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(normalized))) {
    const value = match[1] || match[2] || match[3];
    if (value) args.push(value.trim());
  }
  return args;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveSendIntervalMs(ctx: CommandContext): number {
  const interval = ctx.account.config.sendQueue?.intervalMs;
  return typeof interval === "number" && interval >= 0 ? interval : 400;
}

async function appendOperationLog(ctx: CommandContext, entry: Record<string, unknown>): Promise<void> {
  const logPath = ctx.account.config.operations?.logPath?.trim();
  if (!logPath) return;
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // ignore
  }
}

async function zipDirectory(sourceDir: string): Promise<{ zipPath: string; cleanup: () => Promise<void> }> {
  const tempDir = await mkdtemp(join(tmpdir(), "openclaw-wecom-zip-"));
  const zipPath = join(tempDir, `${basename(sourceDir)}.zip`);
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolve());
    archive.on("error", (err) => reject(err));
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
  return {
    zipPath,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function sendFiles(ctx: CommandContext, paths: string[]): Promise<{ sent: number; skipped: number }> {
  let sent = 0;
  let skipped = 0;
  const maxBytes = ctx.account.config.media?.maxBytes;
  const intervalMs = resolveSendIntervalMs(ctx);
  for (const rawPath of paths) {
    const path = rawPath.startsWith("file://") ? rawPath.replace(/^file:\/\//, "") : rawPath;
    if (!path.startsWith("/")) {
      skipped += 1;
      await sendAndRecord(ctx, `⚠️ 路径需为绝对路径：${rawPath}`);
      continue;
    }
    let cleanup: (() => Promise<void>) | null = null;
    try {
      const info = await stat(path);
      let sendPath = path;

      if (info.isDirectory()) {
        const zipped = await zipDirectory(path);
        sendPath = zipped.zipPath;
        cleanup = zipped.cleanup;
      } else if (!info.isFile()) {
        skipped += 1;
        await sendAndRecord(ctx, `⚠️ 不是文件或文件夹：${path}`);
        continue;
      }

      const sendInfo = await stat(sendPath);
      if (typeof maxBytes === "number" && maxBytes > 0 && sendInfo.size > maxBytes) {
        skipped += 1;
        await sendAndRecord(ctx, `⚠️ 文件过大(${sendInfo.size} bytes)：${sendPath}`);
        if (cleanup) await cleanup();
        continue;
      }
      const buffer = await readFile(sendPath);
      const filename = basename(sendPath) || "file.bin";
      const mediaId = await uploadWecomMedia({
        account: ctx.account,
        type: "file",
        buffer,
        filename,
      });
      await sendWecomFile({
        account: ctx.account,
        toUser: ctx.fromUser,
        chatId: ctx.isGroup ? ctx.chatId : undefined,
        mediaId,
      });
      sent += 1;
      await appendOperationLog(ctx, {
        action: "sendfile",
        accountId: ctx.account.accountId,
        toUser: ctx.fromUser,
        chatId: ctx.chatId,
        path,
        resolvedPath: sendPath,
        size: sendInfo.size,
      });
      if (cleanup) await cleanup();
      if (intervalMs) {
        await sleep(intervalMs);
      }
    } catch (err) {
      skipped += 1;
      await sendAndRecord(ctx, `⚠️ 发送失败：${path} (${String(err)})`);
      await appendOperationLog(ctx, {
        action: "sendfile",
        accountId: ctx.account.accountId,
        toUser: ctx.fromUser,
        chatId: ctx.chatId,
        path,
        error: String(err),
      });
      if (cleanup) {
        try {
          await cleanup();
        } catch {
          // ignore cleanup failure
        }
      }
    }
  }
  ctx.statusSink?.({ lastOutboundAt: Date.now() });
  return { sent, skipped };
}

async function handleHelp(ctx: CommandContext): Promise<void> {
  const helpText = `🤖 WeCom 助手使用帮助

可用命令：
/help - 显示此帮助信息
/clear - 清除会话历史，开始新对话
/status - 查看系统状态
/sendfile <path...> - 发送服务器文件（支持多个路径，可用引号）

直接发送消息即可与 AI 对话。`;
  await sendAndRecord(ctx, helpText);
}

async function handleStatus(ctx: CommandContext): Promise<void> {
  const accounts = listWecomAccountIds(ctx.cfg);
  const statusText = `📊 系统状态

渠道：WeCom
会话ID：${ctx.isGroup ? `wecom:group:${ctx.chatId}` : `wecom:${ctx.fromUser}`}
账户ID：${ctx.account.accountId}
已配置账户：${accounts.join(", ") || "default"}

功能状态：
✅ Bot 模式
✅ App 模式
✅ 文本消息
✅ 图片接收
✅ 语音识别
✅ 消息分段
✅ API 限流`;
  await sendAndRecord(ctx, statusText);
}

async function handleClear(ctx: CommandContext): Promise<void> {
  const runtime = getWecomRuntime();
  const peerId = ctx.isGroup ? (ctx.chatId || "unknown") : ctx.fromUser;
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: "wecom",
    accountId: ctx.account.accountId,
    peer: { kind: ctx.isGroup ? "group" : "dm", id: peerId },
  });
  const storePath = runtime.channel.session.resolveStorePath(ctx.cfg.session?.store, {
    agentId: route.agentId,
  });

  const clearFn = (runtime.channel.session as any).clearSession ?? (runtime.channel.session as any).deleteSession;
  if (typeof clearFn === "function") {
    await clearFn.call(runtime.channel.session, {
      storePath,
      sessionKey: route.sessionKey,
    });
    await sendAndRecord(ctx, "✅ 会话已清除，我们可以开始新的对话了！");
    return;
  }

  await sendAndRecord(ctx, "✅ 会话已重置，请开始新的对话。");
}

async function handleSendFile(cmd: string, ctx: CommandContext): Promise<void> {
  const args = parseQuotedArgs(cmd.replace(/^\/sendfile(s)?\s*/i, ""));
  if (args.length === 0) {
    await sendAndRecord(ctx, "用法：/sendfile /absolute/path/to/file1 /absolute/path/to/file2\n支持引号：/sendfile \"/path/with space/a.txt\"");
    return;
  }
  const { sent, skipped } = await sendFiles(ctx, args);
  await sendAndRecord(ctx, `✅ 已发送 ${sent} 个文件${skipped ? `，跳过 ${skipped} 个` : ""}。`);
}

const COMMANDS: Record<string, (ctx: CommandContext) => Promise<void>> = {
  "/help": handleHelp,
  "/status": handleStatus,
  "/clear": handleClear,
};

export async function handleCommand(cmd: string, ctx: CommandContext): Promise<boolean> {
  const key = cmd.trim().split(/\s+/)[0]?.toLowerCase();
  if (!key) return false;
  if (key === "/sendfile" || key === "/sendfiles") {
    ctx.log?.(`[wecom] handling command ${key}`);
    await handleSendFile(cmd, ctx);
    return true;
  }
  const handler = COMMANDS[key];
  if (!handler) return false;
  ctx.log?.(`[wecom] handling command ${key}`);
  await handler(ctx);
  return true;
}
