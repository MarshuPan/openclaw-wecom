import type { ClawdbotConfig } from "openclaw/plugin-sdk";

import { getWecomRuntime } from "./runtime.js";
import { listWecomAccountIds } from "./accounts.js";
import { sendWecomText } from "./wecom-api.js";
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

async function handleHelp(ctx: CommandContext): Promise<void> {
  const helpText = `🤖 WeCom 助手使用帮助

可用命令：
/help - 显示此帮助信息
/clear - 清除会话历史，开始新对话
/status - 查看系统状态

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

const COMMANDS: Record<string, (ctx: CommandContext) => Promise<void>> = {
  "/help": handleHelp,
  "/status": handleStatus,
  "/clear": handleClear,
};

export async function handleCommand(cmd: string, ctx: CommandContext): Promise<boolean> {
  const key = cmd.trim().split(/\s+/)[0]?.toLowerCase();
  if (!key) return false;
  const handler = COMMANDS[key];
  if (!handler) return false;
  ctx.log?.(`[wecom] handling command ${key}`);
  await handler(ctx);
  return true;
}
