import type { IncomingMessage, ServerResponse } from "node:http";
import { XMLParser } from "fast-xml-parser";
import { mkdir, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WecomWebhookTarget } from "./monitor.js";
import { decryptWecomEncrypted, verifyWecomSignature } from "./crypto.js";
import { getWecomRuntime } from "./runtime.js";
import { handleCommand } from "./commands.js";
import { markdownToWecomText } from "./format.js";
import { downloadWecomMedia, fetchMediaFromUrl, sendWecomFile, sendWecomImage, sendWecomText, sendWecomVideo, sendWecomVoice, uploadWecomMedia } from "./wecom-api.js";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
  processEntities: false,
});

const MAX_REQUEST_BODY_SIZE = 1024 * 1024;

function parseIncomingXml(xml: string): Record<string, any> {
  const obj = xmlParser.parse(xml);
  const root = (obj as any)?.xml ?? obj;
  return root ?? {};
}

function resolveQueryParams(req: IncomingMessage): URLSearchParams {
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams;
}

function resolveSignatureParam(params: URLSearchParams): string {
  return (
    params.get("msg_signature") ??
    params.get("msgsignature") ??
    params.get("signature") ??
    ""
  );
}

function shouldHandleApp(target: WecomWebhookTarget): boolean {
  const mode = target.account.mode;
  return mode === "app" || mode === "both";
}

async function readRequestBody(req: IncomingMessage, maxSize = MAX_REQUEST_BODY_SIZE): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    req.on("data", (c) => {
      const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        reject(new Error(`Request body too large (limit: ${maxSize} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function logVerbose(target: WecomWebhookTarget, message: string): void {
  target.runtime.log?.(`[wecom] ${message}`);
}

function isTextCommand(text: string): boolean {
  return text.trim().startsWith("/");
}

function resolveExtFromContentType(contentType: string, fallback: string): string {
  if (!contentType) return fallback;
  if (contentType.includes("png")) return "png";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("mp4")) return "mp4";
  if (contentType.includes("amr")) return "amr";
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("mp3")) return "mp3";
  return fallback;
}

const cleanupExecuted = new Set<string>();

async function cleanupMediaDir(
  dir: string,
  retentionHours?: number,
  cleanupOnStart?: boolean,
): Promise<void> {
  if (cleanupOnStart === false) return;
  if (!retentionHours || retentionHours <= 0) return;
  if (cleanupExecuted.has(dir)) return;
  cleanupExecuted.add(dir);
  const cutoff = Date.now() - retentionHours * 3600 * 1000;
  try {
    const entries = await readdir(dir);
    await Promise.all(entries.map(async (entry) => {
      const full = join(dir, entry);
      try {
        const info = await stat(full);
        if (info.isFile() && info.mtimeMs < cutoff) {
          await rm(full, { force: true });
        }
      } catch {
        // ignore
      }
    }));
  } catch {
    // ignore
  }
}

function resolveMediaTempDir(target: WecomWebhookTarget): string {
  return target.account.config.media?.tempDir?.trim()
    || join(tmpdir(), "openclaw-wecom");
}

function resolveMediaMaxBytes(target: WecomWebhookTarget): number | undefined {
  const maxBytes = target.account.config.media?.maxBytes;
  return typeof maxBytes === "number" && maxBytes > 0 ? maxBytes : undefined;
}

function normalizeMediaType(raw?: string): "image" | "voice" | "video" | "file" | null {
  if (!raw) return null;
  const value = raw.toLowerCase();
  if (value === "image" || value === "voice" || value === "video" || value === "file") return value;
  return null;
}

function sanitizeFilename(name: string, fallback: string): string {
  const base = name.split(/[/\\\\]/).pop() ?? "";
  const trimmed = base.trim();
  const safe = trimmed
    .replace(/[^\w.\-() ]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  const finalName = safe.slice(0, 120);
  return finalName || fallback;
}


async function startAgentForApp(params: {
  target: WecomWebhookTarget;
  fromUser: string;
  chatId?: string;
  isGroup: boolean;
  messageText: string;
}): Promise<void> {
  const { target, fromUser, chatId, isGroup, messageText } = params;
  const core = getWecomRuntime();
  const config = target.config;
  const account = target.account;

  const peerId = isGroup ? (chatId || "unknown") : fromUser;
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "wecom",
    accountId: account.accountId,
    peer: { kind: isGroup ? "group" : "dm", id: peerId },
  });

  const fromLabel = isGroup ? `group:${peerId}` : `user:${fromUser}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "WeCom",
    from: fromLabel,
    previousTimestamp,
    envelope: envelopeOptions,
    body: messageText,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: messageText,
    CommandBody: messageText,
    From: isGroup ? `wecom:group:${peerId}` : `wecom:${fromUser}`,
    To: `wecom:${peerId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: fromUser,
    SenderId: fromUser,
    Provider: "wecom",
    Surface: "wecom",
    MessageSid: `wecom-${Date.now()}`,
    OriginatingChannel: "wecom",
    OriginatingTo: `wecom:${peerId}`,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      target.runtime.error?.(`wecom: failed updating session meta: ${String(err)}`);
    },
  });

  (core.channel as any)?.activity?.record?.({
    channel: "wecom",
    accountId: account.accountId,
    direction: "inbound",
  });

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: config,
    channel: "wecom",
    accountId: account.accountId,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload, info) => {
        const maybeMediaUrl = (payload as any).mediaUrl as string | undefined;
        const maybeMediaType = (payload as any).mediaType as string | undefined;
        if (maybeMediaUrl) {
          try {
            const media = await fetchMediaFromUrl(maybeMediaUrl, account);
            const type = normalizeMediaType(maybeMediaType) ?? "file";
            const ext = resolveExtFromContentType(media.contentType, type);
            const mediaId = await uploadWecomMedia({
              account,
              type: type as "image" | "voice" | "video" | "file",
              buffer: media.buffer,
              filename: `${type}.${ext}`,
            });
            if (type === "image") {
              await sendWecomImage({ account, toUser: fromUser, chatId: isGroup ? chatId : undefined, mediaId });
              logVerbose(target, `app image reply delivered (${info.kind}) to ${fromUser}`);
            } else if (type === "voice") {
              await sendWecomVoice({ account, toUser: fromUser, chatId: isGroup ? chatId : undefined, mediaId });
              logVerbose(target, `app voice reply delivered (${info.kind}) to ${fromUser}`);
            } else if (type === "video") {
              const title = (payload as any).title as string | undefined;
              const description = (payload as any).description as string | undefined;
              await sendWecomVideo({ account, toUser: fromUser, chatId: isGroup ? chatId : undefined, mediaId, title, description });
              logVerbose(target, `app video reply delivered (${info.kind}) to ${fromUser}`);
            } else if (type === "file") {
              await sendWecomFile({ account, toUser: fromUser, chatId: isGroup ? chatId : undefined, mediaId });
              logVerbose(target, `app file reply delivered (${info.kind}) to ${fromUser}`);
            }
            target.statusSink?.({ lastOutboundAt: Date.now() });
          } catch (err) {
            target.runtime.error?.(`wecom app media reply failed: ${String(err)}`);
          }
        }

        const text = markdownToWecomText(core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode));
        if (!text) return;
        await sendWecomText({ account, toUser: fromUser, chatId: isGroup ? chatId : undefined, text });
        (core.channel as any)?.activity?.record?.({
          channel: "wecom",
          accountId: account.accountId,
          direction: "outbound",
        });
        target.statusSink?.({ lastOutboundAt: Date.now() });
        logVerbose(target, `app reply delivered (${info.kind}) to ${fromUser}`);
      },
      onError: (err, info) => {
        target.runtime.error?.(`[${account.accountId}] wecom app ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      disableBlockStreaming: true,
    },
  });
}

async function processAppMessage(params: {
  target: WecomWebhookTarget;
  decryptedXml: string;
  msgObj: Record<string, any>;
}): Promise<void> {
  const { target, msgObj } = params;
  const msgType = String(msgObj?.MsgType ?? "").toLowerCase();
  const fromUser = String(msgObj?.FromUserName ?? "");
  const chatId = msgObj?.ChatId ? String(msgObj.ChatId) : "";
  const isGroup = Boolean(chatId);
  const summary = msgObj?.Content ? String(msgObj.Content).slice(0, 120) : "";
  logVerbose(target, `app inbound: MsgType=${msgType} From=${fromUser} ChatId=${chatId || "N/A"} Content=${summary}`);

  if (!fromUser) return;

  let messageText = "";
  let tempImagePath: string | null = null;

  if (msgType === "text") {
    messageText = String(msgObj?.Content ?? "");
  }

  if (msgType === "voice") {
    const recognition = String(msgObj?.Recognition ?? "").trim();
    if (recognition) {
      messageText = `[语音消息转写] ${recognition}`;
    } else {
      const mediaId = String(msgObj?.MediaId ?? "");
      if (mediaId) {
        try {
          const media = await downloadWecomMedia({ account: target.account, mediaId });
          const maxBytes = resolveMediaMaxBytes(target);
          if (maxBytes && media.buffer.length > maxBytes) {
            messageText = "[语音消息过大，未处理]\n\n请发送更短的语音消息。";
          } else {
          const ext = resolveExtFromContentType(media.contentType, "amr");
          const tempDir = resolveMediaTempDir(target);
          await mkdir(tempDir, { recursive: true });
          await cleanupMediaDir(
            tempDir,
            target.account.config.media?.retentionHours,
            target.account.config.media?.cleanupOnStart,
          );
          const tempVoicePath = join(tempDir, `voice-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
          await writeFile(tempVoicePath, media.buffer);
          messageText = `[用户发送了一条语音消息，已保存到: ${tempVoicePath}]\n\n请根据语音内容回复用户。`;
          }
        } catch (err) {
          target.runtime.error?.(`wecom app voice download failed: ${String(err)}`);
          messageText = "[用户发送了一条语音消息，但下载失败]\n\n请告诉用户语音处理暂时不可用。";
        }
      } else {
        messageText = "[用户发送了一条语音消息]\n\n请告诉用户语音处理暂时不可用。";
      }
    }
  }

  if (msgType === "image") {
    const mediaId = String(msgObj?.MediaId ?? "");
    const picUrl = String(msgObj?.PicUrl ?? "");
    try {
      let buffer: Buffer | null = null;
      let contentType = "";
      if (mediaId) {
        const media = await downloadWecomMedia({ account: target.account, mediaId });
        buffer = media.buffer;
        contentType = media.contentType;
      } else if (picUrl) {
        const media = await fetchMediaFromUrl(picUrl, target.account);
        buffer = media.buffer;
        contentType = media.contentType;
      }

      if (buffer) {
        const maxBytes = resolveMediaMaxBytes(target);
        if (maxBytes && buffer.length > maxBytes) {
          messageText = "[图片过大，未处理]\n\n请发送更小的图片。";
        } else {
        const ext = resolveExtFromContentType(contentType, "jpg");
        const tempDir = resolveMediaTempDir(target);
        await mkdir(tempDir, { recursive: true });
        await cleanupMediaDir(
          tempDir,
          target.account.config.media?.retentionHours,
          target.account.config.media?.cleanupOnStart,
        );
        tempImagePath = join(tempDir, `image-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
        await writeFile(tempImagePath, buffer);
        messageText = `[用户发送了一张图片，已保存到: ${tempImagePath}]\n\n请根据图片内容回复用户。`;
        }
      } else {
        messageText = "[用户发送了一张图片，但下载失败]\n\n请告诉用户图片处理暂时不可用。";
      }
    } catch (err) {
      target.runtime.error?.(`wecom app image download failed: ${String(err)}`);
      messageText = "[用户发送了一张图片，但下载失败]\n\n请告诉用户图片处理暂时不可用。";
    }
  }

  if (msgType === "link") {
    const title = String(msgObj?.Title ?? "(无标题)");
    const desc = String(msgObj?.Description ?? "(无描述)");
    const url = String(msgObj?.Url ?? "(无链接)");
    messageText = `[用户分享了一个链接]\n标题: ${title}\n描述: ${desc}\n链接: ${url}\n\n请根据链接内容回复用户。`;
  }

  if (msgType === "video") {
    const mediaId = String(msgObj?.MediaId ?? "");
    if (mediaId) {
      try {
        const media = await downloadWecomMedia({ account: target.account, mediaId });
        const maxBytes = resolveMediaMaxBytes(target);
        if (maxBytes && media.buffer.length > maxBytes) {
          messageText = "[视频过大，未处理]\n\n请发送更小的视频。";
        } else {
        const ext = resolveExtFromContentType(media.contentType, "mp4");
        const tempDir = resolveMediaTempDir(target);
        await mkdir(tempDir, { recursive: true });
        await cleanupMediaDir(
          tempDir,
          target.account.config.media?.retentionHours,
          target.account.config.media?.cleanupOnStart,
        );
        const tempVideoPath = join(tempDir, `video-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
        await writeFile(tempVideoPath, media.buffer);
        messageText = `[用户发送了一个视频文件，已保存到: ${tempVideoPath}]\n\n请根据视频内容回复用户。`;
        }
      } catch (err) {
        target.runtime.error?.(`wecom app video download failed: ${String(err)}`);
        messageText = "[用户发送了一个视频，但下载失败]\n\n请告诉用户视频处理暂时不可用。";
      }
    }
  }

  if (msgType === "file") {
    const mediaId = String(msgObj?.MediaId ?? "");
    const fileName = String(msgObj?.FileName ?? "");
    if (mediaId) {
      try {
        const media = await downloadWecomMedia({ account: target.account, mediaId });
        const maxBytes = resolveMediaMaxBytes(target);
        if (maxBytes && media.buffer.length > maxBytes) {
          messageText = "[文件过大，未处理]\n\n请发送更小的文件。";
        } else {
        const ext = fileName.includes(".") ? fileName.split(".").pop() : resolveExtFromContentType(media.contentType, "bin");
        const tempDir = resolveMediaTempDir(target);
        await mkdir(tempDir, { recursive: true });
        await cleanupMediaDir(
          tempDir,
          target.account.config.media?.retentionHours,
          target.account.config.media?.cleanupOnStart,
        );
        const safeName = sanitizeFilename(fileName, `file-${Date.now()}.${ext}`);
        const tempFilePath = join(tempDir, safeName);
        await writeFile(tempFilePath, media.buffer);
        messageText = `[用户发送了一个文件: ${safeName}，已保存到: ${tempFilePath}]\n\n请根据文件内容回复用户。`;
        }
      } catch (err) {
        target.runtime.error?.(`wecom app file download failed: ${String(err)}`);
        messageText = "[用户发送了一个文件，但下载失败]\n\n请告诉用户文件处理暂时不可用。";
      }
    }
  }

  if (!messageText) {
    return;
  }

  if (msgType === "text" && isTextCommand(messageText)) {
    const handled = await handleCommand(messageText, {
      account: target.account,
      fromUser,
      chatId,
      isGroup,
      cfg: target.config,
      log: target.runtime.log,
      statusSink: target.statusSink,
    });
    if (handled) return;
  }

  try {
    await startAgentForApp({
      target,
      fromUser,
      chatId,
      isGroup,
      messageText,
    });
  } catch (err) {
    target.runtime.error?.(`wecom app agent failed: ${String(err)}`);
    try {
      await sendWecomText({
        account: target.account,
        toUser: fromUser,
        chatId: isGroup ? chatId : undefined,
        text: "抱歉，处理您的消息时出现错误，请稍后重试。",
      });
    } catch {
      // ignore
    }
  } finally {
    if (tempImagePath) {
      unlink(tempImagePath).catch(() => {});
    }
  }
}

export async function handleWecomAppWebhook(params: {
  req: IncomingMessage;
  res: ServerResponse;
  targets: WecomWebhookTarget[];
}): Promise<boolean> {
  const { req, res, targets } = params;
  const query = resolveQueryParams(req);
  const timestamp = query.get("timestamp") ?? "";
  const nonce = query.get("nonce") ?? "";
  const signature = resolveSignatureParam(query);

  if (req.method === "GET") {
    const echostr = query.get("echostr") ?? "";
    if (!timestamp || !nonce || !signature || !echostr) {
      return false;
    }

    const target = targets.find((candidate) => {
      if (!shouldHandleApp(candidate)) return false;
      const token = candidate.account.callbackToken ?? "";
      const aesKey = candidate.account.callbackAesKey ?? "";
      if (!token || !aesKey) return false;
      return verifyWecomSignature({
        token,
        timestamp,
        nonce,
        encrypt: echostr,
        signature,
      });
    });

    if (!target || !target.account.callbackAesKey) {
      return false;
    }

    try {
      const plain = decryptWecomEncrypted({
        encodingAESKey: target.account.callbackAesKey,
        receiveId: target.account.corpId ?? "",
        encrypt: echostr,
      });
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(plain);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.statusCode = 400;
      res.end(msg || "decrypt failed");
      return true;
    }
  }

  if (req.method !== "POST") {
    return false;
  }

  if (!timestamp || !nonce || !signature) {
    return false;
  }

  let rawXml = "";
  try {
    rawXml = await readRequestBody(req, MAX_REQUEST_BODY_SIZE);
  } catch {
    res.statusCode = 413;
    res.end("payload too large");
    return true;
  }

  if (!rawXml.trim().startsWith("<")) {
    return false;
  }

  let incoming: Record<string, any>;
  try {
    incoming = parseIncomingXml(rawXml);
  } catch {
    return false;
  }

  const encrypt = String(incoming?.Encrypt ?? "");
  if (!encrypt) {
    res.statusCode = 400;
    res.end("Missing Encrypt");
    return true;
  }

  const target = targets.find((candidate) => {
    if (!shouldHandleApp(candidate)) return false;
    const token = candidate.account.callbackToken ?? "";
    const aesKey = candidate.account.callbackAesKey ?? "";
    if (!token || !aesKey) return false;
    return verifyWecomSignature({
      token,
      timestamp,
      nonce,
      encrypt,
      signature,
    });
  });

  if (!target) {
    return false;
  }

  if (!target.account.callbackAesKey || !target.account.callbackToken) {
    res.statusCode = 500;
    res.end("wecom app not configured");
    return true;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("success");

  let decryptedXml = "";
  try {
    decryptedXml = decryptWecomEncrypted({
      encodingAESKey: target.account.callbackAesKey,
      receiveId: target.account.corpId ?? "",
      encrypt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    target.runtime.error?.(`wecom app decrypt failed: ${msg}`);
    return true;
  }

  let msgObj: Record<string, any> = {};
  try {
    msgObj = parseIncomingXml(decryptedXml);
  } catch (err) {
    target.runtime.error?.(`wecom app parse xml failed: ${String(err)}`);
    return true;
  }

  target.statusSink?.({ lastInboundAt: Date.now() });

  processAppMessage({ target, decryptedXml, msgObj }).catch((err) => {
    target.runtime.error?.(`wecom app async processing failed: ${String(err)}`);
  });

  return true;
}
