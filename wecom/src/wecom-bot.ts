import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { PluginRuntime } from "openclaw/plugin-sdk";

import type { WecomWebhookTarget } from "./monitor.js";
import type { ResolvedWecomAccount, WecomInboundMessage } from "./types.js";
import {
  computeWecomMsgSignature,
  decryptWecomEncrypted,
  decryptWecomMedia,
  encryptWecomPlaintext,
  verifyWecomSignature,
} from "./crypto.js";
import {
  MEDIA_TOO_LARGE_ERROR,
  downloadWecomMedia,
  fetchMediaFromUrl,
  sendWecomFile,
  sendWecomImage,
  sendWecomVideo,
  sendWecomVoice,
  uploadWecomMedia,
} from "./wecom-api.js";
import { getWecomRuntime } from "./runtime.js";
import { describeImageWithVision, resolveVisionConfig } from "./media-vision.js";
import {
  extractFileTextPreview,
  resolveAutoAudioConfig,
  resolveAutoFileConfig,
  resolveAutoVideoConfig,
  summarizeVideoWithVision,
  transcribeAudioWithOpenAI,
} from "./media-auto.js";
import {
  cleanupMediaDir,
  resolveExtFromContentType,
  resolveMediaMaxBytes,
  resolveMediaRetentionMs,
  resolveMediaTempDir,
  sanitizeFilename,
} from "./media-utils.js";

const STREAM_TTL_MS = 10 * 60 * 1000;
const STREAM_MAX_BYTES = 20_480;
const STREAM_MAX_ENTRIES = 500;
const DEDUPE_TTL_MS = 2 * 60 * 1000;
const DEDUPE_MAX_ENTRIES = 2_000;
const MEDIA_CACHE_MAX_ENTRIES = 200;

const mediaCache = new Map<string, { entry: InboundMedia; createdAt: number; size: number; summary?: string }>();

type StreamState = {
  streamId: string;
  msgid?: string;
  responseUrl?: string;
  createdAt: number;
  updatedAt: number;
  started: boolean;
  finished: boolean;
  error?: string;
  content: string;
};

type InboundMedia = {
  path: string;
  type: string;
  mimeType?: string;
  url?: string;
};

type InboundBody = {
  text: string;
  media?: InboundMedia;
};

const streams = new Map<string, StreamState>();
const msgidToStreamId = new Map<string, string>();
const recentEncrypts = new Map<string, { ts: number; streamId?: string }>();

function pruneStreams(): void {
  const cutoff = Date.now() - STREAM_TTL_MS;
  for (const [id, state] of streams.entries()) {
    if (state.updatedAt < cutoff) {
      streams.delete(id);
    }
  }
  for (const [msgid, id] of msgidToStreamId.entries()) {
    if (!streams.has(id)) {
      msgidToStreamId.delete(msgid);
    }
  }

  const dedupeCutoff = Date.now() - DEDUPE_TTL_MS;
  for (const [hash, entry] of recentEncrypts.entries()) {
    if (entry.ts < dedupeCutoff) {
      recentEncrypts.delete(hash);
    }
  }

  if (streams.size > STREAM_MAX_ENTRIES) {
    const sorted = Array.from(streams.entries()).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    const overflow = sorted.length - STREAM_MAX_ENTRIES;
    for (let i = 0; i < overflow; i += 1) {
      const [streamId] = sorted[i]!;
      streams.delete(streamId);
    }
  }

  if (recentEncrypts.size > DEDUPE_MAX_ENTRIES) {
    const sorted = Array.from(recentEncrypts.entries()).sort((a, b) => a[1].ts - b[1].ts);
    const overflow = sorted.length - DEDUPE_MAX_ENTRIES;
    for (let i = 0; i < overflow; i += 1) {
      recentEncrypts.delete(sorted[i]![0]);
    }
  }
}

function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const slice = buf.subarray(buf.length - maxBytes);
  return slice.toString("utf8");
}


function jsonOk(res: ServerResponse, body: unknown): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          resolve({ ok: false, error: "empty payload" });
          return;
        }
        resolve({ ok: true, value: JSON.parse(raw) as unknown });
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

function buildEncryptedJsonReply(params: {
  account: ResolvedWecomAccount;
  plaintextJson: unknown;
  nonce: string;
  timestamp: string;
}): { encrypt: string; msg_signature: string; timestamp: string; nonce: string } {
  const plaintext = JSON.stringify(params.plaintextJson ?? {});
  const encrypt = encryptWecomPlaintext({
    encodingAESKey: params.account.encodingAESKey ?? "",
    receiveId: params.account.receiveId ?? "",
    plaintext,
  });
  const msgsignature = computeWecomMsgSignature({
    token: params.account.token ?? "",
    timestamp: params.timestamp,
    nonce: params.nonce,
    encrypt,
  });
  return {
    encrypt,
    msg_signature: msgsignature,
    timestamp: params.timestamp,
    nonce: params.nonce,
  };
}

function resolveQueryParams(req: IncomingMessage): URLSearchParams {
  const rawUrl = req.url ?? "";
  const queryIndex = rawUrl.indexOf("?");
  if (queryIndex < 0) return new URLSearchParams();
  const queryString = rawUrl.slice(queryIndex + 1);
  const params = new URLSearchParams();
  if (!queryString) return params;
  for (const part of queryString.split("&")) {
    if (!part) continue;
    const eqIndex = part.indexOf("=");
    const keyRaw = eqIndex >= 0 ? part.slice(0, eqIndex) : part;
    const valueRaw = eqIndex >= 0 ? part.slice(eqIndex + 1) : "";
    const key = safeDecodeURIComponent(keyRaw);
    const value = safeDecodeURIComponent(valueRaw);
    params.append(key, value);
  }
  return params;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveSignatureParam(params: URLSearchParams): string {
  return (
    params.get("msg_signature") ??
    params.get("msgsignature") ??
    params.get("signature") ??
    ""
  );
}

function buildStreamPlaceholderReply(streamId: string): { msgtype: "stream"; stream: { id: string; finish: boolean; content: string } } {
  return {
    msgtype: "stream",
    stream: {
      id: streamId,
      finish: false,
      content: "\ud83e\udd14\u601d\u8003\u4e2d...",
    },
  };
}

function buildStreamReplyFromState(state: StreamState): { msgtype: "stream"; stream: { id: string; finish: boolean; content: string } } {
  const content = truncateUtf8Bytes(state.content, STREAM_MAX_BYTES);
  return {
    msgtype: "stream",
    stream: {
      id: state.streamId,
      finish: state.finished,
      content,
    },
  };
}

function createStreamId(): string {
  return crypto.randomBytes(16).toString("hex");
}

function hashEncryptPayload(encrypt: string): string {
  return crypto.createHash("sha256").update(encrypt).digest("hex");
}

function logVerbose(target: WecomWebhookTarget, message: string): void {
  try {
    const core = getWecomRuntime();
    const should = core.logging?.shouldLogVerbose?.() ?? false;
    if (should) {
      target.runtime.log?.(`[wecom] ${message}`);
    }
  } catch {
    // runtime not ready; skip verbose logging
  }
}

function parseWecomPlainMessage(raw: string): WecomInboundMessage {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    return {};
  }
  return parsed as WecomInboundMessage;
}

async function waitForStreamContent(streamId: string, maxWaitMs: number): Promise<void> {
  if (maxWaitMs <= 0) return;
  const startedAt = Date.now();
  await new Promise<void>((resolve) => {
    const tick = () => {
      const state = streams.get(streamId);
      if (!state) return resolve();
      if (state.error || state.finished || state.content.trim()) return resolve();
      if (Date.now() - startedAt >= maxWaitMs) return resolve();
      setTimeout(tick, 25);
    };
    tick();
  });
}

async function startAgentForStream(params: {
  target: WecomWebhookTarget;
  accountId: string;
  msg: WecomInboundMessage;
  streamId: string;
}): Promise<void> {
  const { target, msg, streamId } = params;
  const core = getWecomRuntime();
  const config = target.config;
  const account = target.account;

  const userid = msg.from?.userid?.trim() || "unknown";
  const chatType = msg.chattype === "group" ? "group" : "direct";
  const chatId = msg.chattype === "group" ? (msg.chatid?.trim() || "unknown") : userid;
  const inbound = await buildInboundBody({ target, msg });
  const rawBody = inbound.text;

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "wecom",
    accountId: account.accountId,
    peer: { kind: chatType === "group" ? "group" : "dm", id: chatId },
  });

  logVerbose(target, `starting agent processing (streamId=${streamId}, agentId=${route.agentId}, peerKind=${chatType}, peerId=${chatId})`);

  const fromLabel = chatType === "group" ? `group:${chatId}` : `user:${userid}`;
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
    body: rawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: chatType === "group" ? `wecom:group:${chatId}` : `wecom:${userid}`,
    To: `wecom:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: chatType,
    ConversationLabel: fromLabel,
    SenderName: userid,
    SenderId: userid,
    Provider: "wecom",
    Surface: "wecom",
    MessageSid: msg.msgid,
    OriginatingChannel: "wecom",
    OriginatingTo: `wecom:${chatId}`,
  });

  if (inbound.media) {
    ctxPayload.MediaPath = inbound.media.path;
    ctxPayload.MediaType = inbound.media.type;
    if (inbound.media.mimeType) {
      (ctxPayload as any).MediaMimeType = inbound.media.mimeType;
    }
    if (inbound.media.url) {
      ctxPayload.MediaUrl = inbound.media.url;
    }
  }

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      target.runtime.error?.(`wecom: failed updating session meta: ${String(err)}`);
    },
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
      deliver: async (payload) => {
        const canBridgeMedia = account.config.botMediaBridge !== false
          && Boolean(account.corpId && account.corpSecret && account.agentId);
        const toChatId = chatType === "group" ? chatId : undefined;

        if (canBridgeMedia) {
          try {
            const outbound = await loadOutboundMedia({
              payload,
              account,
              maxBytes: resolveMediaMaxBytes(target),
            });
            if (outbound) {
            const mediaId = await uploadWecomMedia({
              account,
              type: outbound.type,
              buffer: outbound.buffer,
              filename: outbound.filename,
            });
            if (outbound.type === "image") {
              await sendWecomImage({ account, toUser: userid, chatId: toChatId, mediaId });
            } else if (outbound.type === "voice") {
              await sendWecomVoice({ account, toUser: userid, chatId: toChatId, mediaId });
            } else if (outbound.type === "video") {
              const title = (payload as any).title as string | undefined;
              const description = (payload as any).description as string | undefined;
              await sendWecomVideo({ account, toUser: userid, chatId: toChatId, mediaId, title, description });
            } else if (outbound.type === "file") {
              await sendWecomFile({ account, toUser: userid, chatId: toChatId, mediaId });
            }
            const current = streams.get(streamId);
            if (current) {
              const note = mediaSentLabel(outbound.type);
              const nextText = current.content ? `${current.content}\n\n${note}` : note;
              current.content = truncateUtf8Bytes(nextText.trim(), STREAM_MAX_BYTES);
              current.updatedAt = Date.now();
            }
            target.statusSink?.({ lastOutboundAt: Date.now() });
            }
          } catch (err) {
            target.runtime.error?.(`[${account.accountId}] wecom bot media bridge failed: ${String(err)}`);
          }
        }

        let text = payload.text ?? "";
        const current = streams.get(streamId);
        if (!current) return;

        const trimmedText = text.trim();
        if (trimmedText.startsWith("{") && trimmedText.includes("\"template_card\"")) {
          try {
            const parsed = JSON.parse(trimmedText) as { template_card?: Record<string, unknown> };
            if (parsed.template_card) {
              const isSingleChat = chatType !== "group";
              const responseUrl = current.responseUrl;
              if (isSingleChat && responseUrl) {
                await fetch(responseUrl, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ msgtype: "template_card", template_card: parsed.template_card }),
                });
                current.finished = true;
                current.content = current.content || "[已发送交互卡片]";
                current.updatedAt = Date.now();
                target.statusSink?.({ lastOutboundAt: Date.now() });
                return;
              }
              const cardTitle = (parsed.template_card as any)?.main_title?.title || "交互卡片";
              const cardDesc = (parsed.template_card as any)?.main_title?.desc || "";
              const buttons = Array.isArray((parsed.template_card as any)?.button_list)
                ? (parsed.template_card as any).button_list.map((b: any) => b?.text).filter(Boolean).join(" / ")
                : "";
              text = `【交互卡片】${cardTitle}${cardDesc ? `\n${cardDesc}` : ""}${buttons ? `\n\n选项: ${buttons}` : ""}`;
            }
          } catch {
            // ignore parse failure, treat as normal text
          }
        }

        text = core.channel.text.convertMarkdownTables(text, tableMode);
        const nextText = current.content
          ? `${current.content}\n\n${text}`.trim()
          : text.trim();
        current.content = truncateUtf8Bytes(nextText, STREAM_MAX_BYTES);
        current.updatedAt = Date.now();
        target.statusSink?.({ lastOutboundAt: Date.now() });
      },
      onError: (err, info) => {
        target.runtime.error?.(`[${account.accountId}] wecom ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });

  const current = streams.get(streamId);
  if (current) {
    current.finished = true;
    current.updatedAt = Date.now();
  }
}

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function isMediaTooLargeError(err: unknown): boolean {
  if (!err) return false;
  if (typeof err === "string") return err.includes(MEDIA_TOO_LARGE_ERROR);
  if (typeof err === "object") {
    const anyErr = err as { code?: string; message?: string };
    if (anyErr.code === MEDIA_TOO_LARGE_ERROR) return true;
    if (typeof anyErr.message === "string" && anyErr.message.includes(MEDIA_TOO_LARGE_ERROR)) return true;
    if (typeof anyErr.message === "string" && anyErr.message.toLowerCase().includes("media too large")) return true;
  }
  return false;
}

function resolveBotMediaUrl(msg: any, msgtype: "image" | "voice" | "video" | "file"): string {
  if (!msg || typeof msg !== "object") return "";
  const block = msg[msgtype] ?? {};
  if (msgtype === "image") {
    return pickString(
      block.url,
      block.imageUrl,
      block.image_url,
      block.picurl,
      block.picUrl,
      block.pic_url,
      msg.imageUrl,
      msg.image_url,
      msg.picurl,
      msg.picUrl,
      msg.pic_url,
      msg.url,
    );
  }
  if (msgtype === "voice") {
    return pickString(
      block.url,
      block.fileurl,
      block.fileUrl,
      block.file_url,
      block.downloadUrl,
      block.download_url,
      block.mediaUrl,
      block.media_url,
      msg.voiceUrl,
      msg.voice_url,
      msg.url,
    );
  }
  if (msgtype === "video") {
    return pickString(
      block.url,
      block.fileurl,
      block.fileUrl,
      block.file_url,
      block.downloadUrl,
      block.download_url,
      block.mediaUrl,
      block.media_url,
      msg.videoUrl,
      msg.video_url,
      msg.url,
    );
  }
  return pickString(
    block.url,
    block.fileurl,
    block.fileUrl,
    block.file_url,
    block.downloadUrl,
    block.download_url,
    block.mediaUrl,
    block.media_url,
    msg.fileUrl,
    msg.file_url,
    msg.url,
  );
}

function resolveBotMediaBase64(msg: any, msgtype: "image" | "voice" | "video" | "file"): string {
  if (!msg || typeof msg !== "object") return "";
  const block = msg[msgtype] ?? {};
  return pickString(
    block.base64,
    block.base64Data,
    block.data,
    msg.base64,
    msg.data,
  );
}

function resolveBotMediaId(msg: any, msgtype: "image" | "voice" | "video" | "file"): string {
  if (!msg || typeof msg !== "object") return "";
  const block = msg[msgtype] ?? {};
  return pickString(
    block.media_id,
    block.mediaId,
    block.mediaid,
    block.mediaID,
    msg.media_id,
    msg.mediaId,
    msg.mediaid,
    msg.mediaID,
  );
}

function resolveBotMediaFilename(msg: any): string {
  if (!msg || typeof msg !== "object") return "";
  const block = msg.file ?? {};
  return pickString(
    block.filename,
    block.fileName,
    block.name,
    block.file_name,
    block.file,
    msg.filename,
    msg.fileName,
    msg.name,
  );
}

async function buildBotMediaMessage(params: {
  target: WecomWebhookTarget;
  msgtype: "image" | "voice" | "video" | "file";
  url?: string;
  base64?: string;
  mediaId?: string;
  filename?: string;
}): Promise<InboundBody> {
  const { target, msgtype, url, base64, mediaId, filename } = params;

  const fallbackLabel = msgtype === "image"
    ? "[image]"
    : msgtype === "voice"
      ? "[voice]"
      : msgtype === "video"
        ? "[video]"
        : "[file]";

  if (!url && !base64 && !mediaId) return { text: fallbackLabel };
  const hasAppCreds = Boolean(target.account.corpId && target.account.corpSecret && target.account.agentId);
  if (!url && !base64 && mediaId && !hasAppCreds) {
    return {
      text: "[用户发送了媒体，但当前仅配置 Bot]\n\n未配置 App 凭据，无法下载或识别媒体内容。请补充 corpId/corpSecret/agentId。",
    };
  }

  try {
    const cacheKey = buildMediaCacheKey({ url, base64, mediaId });
    const cached = await getCachedMedia(cacheKey, resolveMediaRetentionMs(target));
    if (cached) {
      if (msgtype === "image" && cached.summary) {
        return {
          text: `[用户发送了一张图片]\n\n[图片识别结果]\n${cached.summary}\n\n请根据识别结果回复用户。`,
          media: cached.media,
        };
      }
      if (msgtype === "file") {
        const safeName = sanitizeFilename(filename || basename(cached.media.path), "file");
        const fileCfg = resolveAutoFileConfig(target.account.config);
        const preview = fileCfg
          ? await extractFileTextPreview({ path: cached.media.path, mimeType: cached.media.mimeType, cfg: fileCfg })
          : null;
        return {
          text: preview
            ? `[用户发送了一个文件: ${safeName}，已保存到: ${cached.media.path}]\n\n[文件内容预览]\n${preview}\n\n如需更多内容请使用 Read 工具。`
            : `[用户发送了一个文件: ${safeName}，已保存到: ${cached.media.path}]\n\n请使用 Read 工具查看这个文件的内容并回复用户。`,
          media: cached.media,
        };
      }
      return {
        text: buildInboundMediaPrompt(msgtype, filename),
        media: cached.media,
      };
    }

    let buffer: Buffer | null = null;
    let contentType = "";
    const maxBytes = resolveMediaMaxBytes(target);
    if (base64) {
      const parsed = parseBase64Input(base64);
      buffer = Buffer.from(parsed.data, "base64");
      if (parsed.mimeType) contentType = parsed.mimeType;
      if (!contentType) {
        if (msgtype === "image") contentType = "image/jpeg";
        else if (msgtype === "voice") contentType = "audio/amr";
        else if (msgtype === "video") contentType = "video/mp4";
        else contentType = "application/octet-stream";
      }
    } else if (url) {
      const media = await fetchMediaFromUrl(url, target.account, maxBytes);
      const aesKey = target.account.encodingAESKey || "";
      if (aesKey) {
        try {
          buffer = decryptWecomMedia({ encodingAESKey: aesKey, buffer: media.buffer });
          if (msgtype === "image") contentType = "image/jpeg";
          else if (msgtype === "voice") contentType = "audio/amr";
          else if (msgtype === "video") contentType = "video/mp4";
          else contentType = "application/octet-stream";
        } catch (err) {
          target.runtime.error?.(`[${target.account.accountId}] wecom bot media decrypt failed: ${String(err)}`);
          buffer = media.buffer;
          contentType = media.contentType;
        }
      } else {
        buffer = media.buffer;
        contentType = media.contentType;
      }
    } else if (mediaId && hasAppCreds) {
      const media = await downloadWecomMedia({ account: target.account, mediaId, maxBytes });
      buffer = media.buffer;
      contentType = media.contentType;
    }

    if (!buffer) return { text: fallbackLabel };

    if (maxBytes && buffer.length > maxBytes) {
      if (msgtype === "image") return { text: "[图片过大，未处理]\n\n请发送更小的图片。" };
      if (msgtype === "voice") return { text: "[语音消息过大，未处理]\n\n请发送更短的语音消息。" };
      if (msgtype === "video") return { text: "[视频过大，未处理]\n\n请发送更小的视频。" };
      return { text: "[文件过大，未处理]\n\n请发送更小的文件。" };
    }

    const tempDir = resolveMediaTempDir(target);
    await mkdir(tempDir, { recursive: true });
    await cleanupMediaDir(
      tempDir,
      target.account.config.media?.retentionHours,
      target.account.config.media?.cleanupOnStart,
    );

    const fallbackExt = msgtype === "image"
      ? "jpg"
      : msgtype === "voice"
        ? "amr"
        : msgtype === "video"
          ? "mp4"
          : "bin";
    const ext = resolveExtFromContentType(contentType, fallbackExt);

    if (msgtype === "file") {
      const safeName = sanitizeFilename(filename || "", `file-${Date.now()}.${ext}`);
      const tempFilePath = join(tempDir, safeName);
      await writeFile(tempFilePath, buffer);
      const media: InboundMedia = {
        path: tempFilePath,
        type: "file",
        mimeType: contentType || "application/octet-stream",
        url,
      };
      storeCachedMedia(cacheKey, media, buffer.length);
      const fileCfg = resolveAutoFileConfig(target.account.config);
      const preview = fileCfg
        ? await extractFileTextPreview({ path: tempFilePath, mimeType: media.mimeType, cfg: fileCfg })
        : null;
      return {
        text: preview
          ? `[用户发送了一个文件: ${safeName}，已保存到: ${tempFilePath}]\n\n[文件内容预览]\n${preview}\n\n如需更多内容请使用 Read 工具。`
          : `[用户发送了一个文件: ${safeName}，已保存到: ${tempFilePath}]\n\n请使用 Read 工具查看这个文件的内容并回复用户。`,
        media,
      };
    }

    const tempPath = join(
      tempDir,
      `${msgtype}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`,
    );
    await writeFile(tempPath, buffer);

    if (msgtype === "image") {
      const media: InboundMedia = {
        path: tempPath,
        type: "image",
        mimeType: contentType || "image/jpeg",
        url,
      };
      const visionConfig = resolveVisionConfig(target.account.config);
      const summary = visionConfig
        ? await describeImageWithVision({
          config: visionConfig,
          buffer,
          mimeType: media.mimeType || "image/jpeg",
        })
        : null;
      storeCachedMedia(cacheKey, media, buffer.length, summary ?? undefined);
      return {
        text: summary
          ? `[用户发送了一张图片]\n\n[图片识别结果]\n${summary}\n\n请根据识别结果回复用户。`
          : buildInboundMediaPrompt("image"),
        media,
      };
    }
    if (msgtype === "voice") {
      const media: InboundMedia = {
        path: tempPath,
        type: "voice",
        mimeType: contentType || "audio/amr",
        url,
      };
      storeCachedMedia(cacheKey, media, buffer.length);
      const audioCfg = resolveAutoAudioConfig(target.account.config);
      const transcript = audioCfg
        ? await transcribeAudioWithOpenAI({ cfg: audioCfg, buffer, mimeType: media.mimeType })
        : null;
      return {
        text: transcript ? `[语音消息转写] ${transcript}` : buildInboundMediaPrompt("voice"),
        media,
      };
    }
    if (msgtype === "video") {
      const media: InboundMedia = {
        path: tempPath,
        type: "video",
        mimeType: contentType || "video/mp4",
        url,
      };
      storeCachedMedia(cacheKey, media, buffer.length);
      const videoCfg = resolveAutoVideoConfig(target.account.config);
      const summary = videoCfg
        ? await summarizeVideoWithVision({ cfg: videoCfg, account: target.account.config, videoPath: tempPath })
        : null;
      return {
        text: summary
          ? `[用户发送了一个视频文件]\n\n[视频画面概述]\n${summary}\n\n请根据视频内容回复用户。`
          : buildInboundMediaPrompt("video"),
        media,
      };
    }
    return { text: fallbackLabel };
  } catch (err) {
    target.runtime.error?.(`wecom bot ${msgtype} download failed: ${String(err)}`);
    if (isMediaTooLargeError(err)) {
      if (msgtype === "image") return { text: "[图片过大，未处理]\n\n请发送更小的图片。" };
      if (msgtype === "voice") return { text: "[语音消息过大，未处理]\n\n请发送更短的语音消息。" };
      if (msgtype === "video") return { text: "[视频过大，未处理]\n\n请发送更小的视频。" };
      return { text: "[文件过大，未处理]\n\n请发送更小的文件。" };
    }
    if (msgtype === "image") return { text: "[用户发送了一张图片，但下载失败]\n\n请告诉用户图片处理暂时不可用。" };
    if (msgtype === "voice") return { text: "[用户发送了一条语音消息，但下载失败]\n\n请告诉用户语音处理暂时不可用。" };
    if (msgtype === "video") return { text: "[用户发送了一个视频，但下载失败]\n\n请告诉用户视频处理暂时不可用。" };
    return { text: "[用户发送了一个文件，但下载失败]\n\n请告诉用户文件处理暂时不可用。" };
  }
}

async function buildInboundBody(params: { target: WecomWebhookTarget; msg: WecomInboundMessage }): Promise<InboundBody> {
  const { target, msg } = params;
  const msgtype = String(msg.msgtype ?? "").toLowerCase();
  if (msgtype === "text") {
    const content = (msg as any).text?.content;
    return { text: typeof content === "string" ? content : "" };
  }
  if (msgtype === "voice") {
    const content = (msg as any).voice?.content;
    if (typeof content === "string" && content.trim()) return { text: content.trim() };
    const recognition = pickString(
      (msg as any).voice?.recognition,
      (msg as any).voice?.text,
      (msg as any).voice?.transcript,
      (msg as any).recognition,
    );
    if (recognition) return { text: recognition };
    const url = resolveBotMediaUrl(msg as any, "voice");
    const base64 = resolveBotMediaBase64(msg as any, "voice");
    const mediaId = resolveBotMediaId(msg as any, "voice");
    return await buildBotMediaMessage({ target, msgtype: "voice", url, base64, mediaId });
  }
  if (msgtype === "mixed") {
    const items = (msg as any).mixed?.msg_item;
    if (Array.isArray(items)) {
      const text = items
        .map((item: any) => {
          const t = String(item?.msgtype ?? "").toLowerCase();
          if (t === "text") return String(item?.text?.content ?? "");
          if (t === "image") return `[image] ${String(item?.image?.url ?? "").trim()}`.trim();
          return `[${t || "item"}]`;
        })
        .filter((part: string) => Boolean(part && part.trim()))
        .join("\n");
      return { text };
    }
    return { text: "[mixed]" };
  }
  if (msgtype === "image") {
    const url = resolveBotMediaUrl(msg as any, "image");
    const base64 = resolveBotMediaBase64(msg as any, "image");
    const mediaId = resolveBotMediaId(msg as any, "image");
    return await buildBotMediaMessage({ target, msgtype: "image", url, base64, mediaId });
  }
  if (msgtype === "file") {
    const url = resolveBotMediaUrl(msg as any, "file");
    const base64 = resolveBotMediaBase64(msg as any, "file");
    const mediaId = resolveBotMediaId(msg as any, "file");
    const filename = resolveBotMediaFilename(msg as any);
    return await buildBotMediaMessage({ target, msgtype: "file", url, base64, mediaId, filename });
  }
  if (msgtype === "video") {
    const url = resolveBotMediaUrl(msg as any, "video");
    const base64 = resolveBotMediaBase64(msg as any, "video");
    const mediaId = resolveBotMediaId(msg as any, "video");
    return await buildBotMediaMessage({ target, msgtype: "video", url, base64, mediaId });
  }
  if (msgtype === "event") {
    const eventtype = String((msg as any).event?.eventtype ?? "").trim();
    return { text: eventtype ? `[event] ${eventtype}` : "[event]" };
  }
  if (msgtype === "stream") {
    const id = String((msg as any).stream?.id ?? "").trim();
    return { text: id ? `[stream_refresh] ${id}` : "[stream_refresh]" };
  }
  return { text: msgtype ? `[${msgtype}]` : "" };
}

function normalizeMediaType(raw?: string): "image" | "voice" | "video" | "file" | null {
  if (!raw) return null;
  const value = raw.toLowerCase();
  if (value === "image" || value === "voice" || value === "video" || value === "file") return value;
  return null;
}

function resolveContentTypeFromExt(ext: string): string {
  const value = ext.toLowerCase();
  if (value === "png") return "image/png";
  if (value === "gif") return "image/gif";
  if (value === "jpg" || value === "jpeg") return "image/jpeg";
  if (value === "webp") return "image/webp";
  if (value === "bmp") return "image/bmp";
  if (value === "amr") return "audio/amr";
  if (value === "wav") return "audio/wav";
  if (value === "mp3") return "audio/mpeg";
  if (value === "m4a") return "audio/mp4";
  if (value === "mp4") return "video/mp4";
  if (value === "mov") return "video/quicktime";
  if (value === "avi") return "video/x-msvideo";
  if (value === "pdf") return "application/pdf";
  if (value === "txt") return "text/plain";
  if (value === "csv") return "text/csv";
  if (value === "json") return "application/json";
  if (value === "doc") return "application/msword";
  if (value === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (value === "xls") return "application/vnd.ms-excel";
  if (value === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (value === "ppt") return "application/vnd.ms-powerpoint";
  if (value === "pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (value === "zip") return "application/zip";
  return "application/octet-stream";
}

function resolveMediaTypeFromContentType(contentType: string): "image" | "voice" | "video" | "file" {
  const value = contentType.toLowerCase();
  if (value.startsWith("image/")) return "image";
  if (value.startsWith("audio/")) return "voice";
  if (value.startsWith("video/")) return "video";
  return "file";
}

function stripFileProtocol(rawPath: string): string {
  return rawPath.startsWith("file://") ? rawPath.replace(/^file:\/\//, "") : rawPath;
}

function parseBase64Input(input: string): { data: string; mimeType?: string } {
  const match = input.match(/^data:([^;]+);base64,(.*)$/i);
  if (match) {
    return { data: match[2], mimeType: match[1] };
  }
  return { data: input };
}

function resolveOutboundMediaSpec(payload: any): {
  type?: string;
  url?: string;
  path?: string;
  base64?: string;
  filename?: string;
  mimeType?: string;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const mediaBlockRaw = payload.media ?? payload.attachment ?? payload.file ?? payload.files;
  const mediaBlock = Array.isArray(mediaBlockRaw) ? mediaBlockRaw[0] : mediaBlockRaw;
  const url = pickString(
    payload.mediaUrl,
    mediaBlock?.url,
    mediaBlock?.mediaUrl,
    mediaBlock?.fileUrl,
    mediaBlock?.file_url,
  );
  const path = pickString(
    payload.mediaPath,
    payload.filePath,
    mediaBlock?.path,
    mediaBlock?.filePath,
    mediaBlock?.localPath,
  );
  const base64 = pickString(
    payload.mediaBase64,
    payload.base64,
    mediaBlock?.base64,
    mediaBlock?.data,
  );
  const type = pickString(payload.mediaType, mediaBlock?.type, mediaBlock?.mediaType);
  const filename = pickString(payload.filename, payload.fileName, mediaBlock?.filename, mediaBlock?.fileName, mediaBlock?.name);
  const mimeType = pickString(payload.mimeType, payload.mediaMimeType, mediaBlock?.mimeType, mediaBlock?.contentType);
  if (!url && !path && !base64) return null;
  return { type, url, path, base64, filename, mimeType };
}

async function loadOutboundMedia(params: {
  payload: any;
  account: ResolvedWecomAccount;
  maxBytes: number | undefined;
}): Promise<{ buffer: Buffer; contentType: string; type: "image" | "voice" | "video" | "file"; filename: string } | null> {
  const spec = resolveOutboundMediaSpec(params.payload);
  if (!spec) return null;

  let buffer: Buffer | null = null;
  let contentType = spec.mimeType ?? "";
  let filename = spec.filename ?? "";

  if (spec.base64) {
    const parsed = parseBase64Input(spec.base64);
    buffer = Buffer.from(parsed.data, "base64");
    if (!contentType && parsed.mimeType) contentType = parsed.mimeType;
  } else if (spec.path) {
    const resolvedPath = stripFileProtocol(spec.path);
    buffer = await readFile(resolvedPath);
    if (!filename) filename = basename(resolvedPath);
    if (!contentType) {
      const ext = extname(resolvedPath).replace(".", "");
      contentType = resolveContentTypeFromExt(ext);
    }
  } else if (spec.url) {
    const media = await fetchMediaFromUrl(spec.url, params.account, params.maxBytes);
    buffer = media.buffer;
    if (!contentType) contentType = media.contentType;
  }

  if (!buffer) return null;
  if (params.maxBytes && buffer.length > params.maxBytes) return null;

  const type = normalizeMediaType(spec.type) ?? resolveMediaTypeFromContentType(contentType || "application/octet-stream");
  const ext = resolveExtFromContentType(contentType || "application/octet-stream", type);
  const safeName = sanitizeFilename(filename, `${type}.${ext}`);

  return { buffer, contentType: contentType || resolveContentTypeFromExt(ext), type, filename: safeName };
}

function mediaSentLabel(type: string): string {
  if (type === "image") return "[已发送图片]";
  if (type === "voice") return "[已发送语音]";
  if (type === "video") return "[已发送视频]";
  if (type === "file") return "[已发送文件]";
  return "[已发送媒体]";
}

function hashCacheKey(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex");
}

function buildMediaCacheKey(params: { url?: string; base64?: string; mediaId?: string }): string | null {
  if (params.mediaId) return `media:${params.mediaId}`;
  if (params.url) return `url:${hashCacheKey(params.url)}`;
  if (params.base64) return `b64:${hashCacheKey(params.base64)}`;
  return null;
}

function pruneMediaCache(): void {
  if (mediaCache.size <= MEDIA_CACHE_MAX_ENTRIES) return;
  const entries = Array.from(mediaCache.entries())
    .sort((a, b) => a[1].createdAt - b[1].createdAt);
  const excess = entries.length - MEDIA_CACHE_MAX_ENTRIES;
  for (let i = 0; i < excess; i += 1) {
    mediaCache.delete(entries[i]![0]);
  }
}

async function getCachedMedia(
  key: string | null,
  retentionMs?: number,
): Promise<{ media: InboundMedia; summary?: string } | null> {
  if (!key) return null;
  const cached = mediaCache.get(key);
  if (!cached) return null;
  if (retentionMs && Date.now() - cached.createdAt > retentionMs) {
    mediaCache.delete(key);
    return null;
  }
  try {
    await stat(cached.entry.path);
  } catch {
    mediaCache.delete(key);
    return null;
  }
  return { media: cached.entry, summary: cached.summary };
}

function storeCachedMedia(key: string | null, entry: InboundMedia, size: number, summary?: string): void {
  if (!key) return;
  mediaCache.set(key, { entry, createdAt: Date.now(), size, summary });
  pruneMediaCache();
}

function buildInboundMediaPrompt(msgtype: "image" | "voice" | "video" | "file", filename?: string): string {
  if (msgtype === "image") return "[用户发送了一张图片]\n\n请根据图片内容回复用户。";
  if (msgtype === "voice") return "[用户发送了一条语音消息]\n\n请根据语音内容回复用户。";
  if (msgtype === "video") return "[用户发送了一个视频文件]\n\n请根据视频内容回复用户。";
  const label = filename ? `用户发送了一个文件: ${filename}` : "用户发送了一个文件";
  return `[${label}]\n\n请根据文件内容回复用户。`;
}

function shouldHandleBot(account: ResolvedWecomAccount): boolean {
  return account.mode === "bot" || account.mode === "both";
}

export async function handleWecomBotWebhook(params: {
  req: IncomingMessage;
  res: ServerResponse;
  targets: WecomWebhookTarget[];
}): Promise<boolean> {
  pruneStreams();

  const { req, res, targets } = params;
  const botTargets = targets.filter((candidate) => shouldHandleBot(candidate.account));
  if (botTargets.length === 0) {
    return false;
  }
  const query = resolveQueryParams(req);
  const timestamp = query.get("timestamp") ?? "";
  const nonce = query.get("nonce") ?? "";
  const signature = resolveSignatureParam(query);

  const firstTarget = targets[0]!;
  logVerbose(firstTarget, `incoming ${req.method} request (timestamp=${timestamp}, nonce=${nonce}, signature=${signature})`);

  if (req.method === "GET") {
    const echostr = query.get("echostr") ?? "";
    if (!timestamp || !nonce || !signature || !echostr) {
      targets[0]?.runtime?.log?.(
        `[wecom] bot GET missing params (timestamp=${Boolean(timestamp)} nonce=${Boolean(nonce)} signature=${Boolean(signature)} echostr=${Boolean(echostr)})`,
      );
      return false;
    }

    const target = botTargets.find((candidate) => {
      if (!shouldHandleBot(candidate.account)) return false;
      if (!candidate.account.configured || !candidate.account.token) return false;
      const ok = verifyWecomSignature({
        token: candidate.account.token,
        timestamp,
        nonce,
        encrypt: echostr,
        signature,
      });
      return ok;
    });
    if (!target || !target.account.encodingAESKey) {
      targets[0]?.runtime?.log?.("[wecom] bot GET signature verify failed");
      return false;
    }
    try {
      const plain = decryptBotEncrypted(target.account, echostr);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(plain);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      targets[0]?.runtime?.error?.(`[wecom] bot GET decrypt failed: ${msg}`);
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

  const body = await readJsonBody(req, 1024 * 1024);
  if (!body.ok) {
    res.statusCode = body.error === "payload too large" ? 413 : 400;
    res.end(body.error ?? "invalid payload");
    return true;
  }
  const record = body.value && typeof body.value === "object" ? (body.value as Record<string, unknown>) : null;
  const encrypt = record ? String(record.encrypt ?? record.Encrypt ?? "") : "";
  if (!encrypt) {
    res.statusCode = 400;
    res.end("missing encrypt");
    return true;
  }

    const target = botTargets.find((candidate) => {
      if (!shouldHandleBot(candidate.account)) return false;
      if (!candidate.account.token) return false;
    const ok = verifyWecomSignature({
      token: candidate.account.token,
      timestamp,
      nonce,
      encrypt,
      signature,
    });
    return ok;
  });
  if (!target) {
    return false;
  }

  if (!target.account.configured || !target.account.token || !target.account.encodingAESKey) {
    res.statusCode = 500;
    res.end("wecom not configured");
    return true;
  }

  const encryptHash = hashEncryptPayload(encrypt);
  const dedupeEntry = recentEncrypts.get(encryptHash);
  if (dedupeEntry && Date.now() - dedupeEntry.ts <= DEDUPE_TTL_MS) {
    const streamId = dedupeEntry.streamId ?? "";
    const state = streamId ? streams.get(streamId) : undefined;
    if (streamId && state) {
      const reply = state.error || state.content.trim()
        ? buildStreamReplyFromState(state)
        : buildStreamPlaceholderReply(streamId);
      logVerbose(target, `bot dedupe hit streamId=${streamId}`);
      jsonOk(res, buildEncryptedJsonReply({
        account: target.account,
        plaintextJson: reply,
        nonce,
        timestamp,
      }));
      dedupeEntry.ts = Date.now();
      return true;
    }
    recentEncrypts.delete(encryptHash);
  }

  let plain: string;
  try {
    plain = decryptBotEncrypted(target.account, encrypt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.statusCode = 400;
    res.end(msg || "decrypt failed");
    return true;
  }

  const msg = parseWecomPlainMessage(plain);
  target.statusSink?.({ lastInboundAt: Date.now() });

  const msgtype = String(msg.msgtype ?? "").toLowerCase();
  const msgid = msg.msgid ? String(msg.msgid) : undefined;
  logVerbose(target, `bot inbound msgtype=${msgtype || "unknown"} msgid=${msgid || "n/a"}`);

  if (msgtype === "stream") {
    const streamId = String((msg as any).stream?.id ?? "").trim();
    const state = streamId ? streams.get(streamId) : undefined;
    const reply = state
      ? buildStreamReplyFromState(state)
      : buildStreamReplyFromState({
          streamId: streamId || "unknown",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          started: true,
          finished: true,
          content: "",
        });
    logVerbose(target, `bot stream refresh reply streamId=${streamId || "unknown"} finished=${Boolean(state?.finished)}`);
    jsonOk(res, buildEncryptedJsonReply({
      account: target.account,
      plaintextJson: reply,
      nonce,
      timestamp,
    }));
    return true;
  }

  if (msgtype !== "event" && msgid && msgidToStreamId.has(msgid)) {
    const streamId = msgidToStreamId.get(msgid) ?? "";
    const reply = buildStreamPlaceholderReply(streamId);
    logVerbose(target, `bot stream placeholder reply streamId=${streamId || "unknown"}`);
    jsonOk(res, buildEncryptedJsonReply({
      account: target.account,
      plaintextJson: reply,
      nonce,
      timestamp,
    }));
    return true;
  }

  if (msgtype === "event") {
    const eventtype = String((msg as any).event?.eventtype ?? "").toLowerCase();
    if (eventtype === "template_card_event") {
      if (msgid && msgidToStreamId.has(msgid)) {
        jsonOk(res, buildEncryptedJsonReply({
          account: target.account,
          plaintextJson: {},
          nonce,
          timestamp,
        }));
        return true;
      }

      const cardEvent = (msg as any).event?.template_card_event;
      let interactionDesc = `[卡片交互] 按钮: ${cardEvent?.event_key || "unknown"}`;
      const selected = cardEvent?.selected_items?.selected_item;
      if (Array.isArray(selected) && selected.length > 0) {
        const selects = selected.map((item: any) => {
          const key = item?.question_key || "unknown";
          const options = Array.isArray(item?.option_ids?.option_id)
            ? item.option_ids.option_id.join(",")
            : "";
          return `${key}=${options}`;
        }).join("; ");
        if (selects) interactionDesc += ` 选择: ${selects}`;
      }
      if (cardEvent?.task_id) interactionDesc += ` (任务ID: ${cardEvent.task_id})`;

      jsonOk(res, buildEncryptedJsonReply({
        account: target.account,
        plaintextJson: {},
        nonce,
        timestamp,
      }));

      const streamId = createStreamId();
      if (msgid) msgidToStreamId.set(msgid, streamId);
      streams.set(streamId, {
        streamId,
        msgid,
        responseUrl: typeof (msg as any).response_url === "string" ? String((msg as any).response_url).trim() : undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        started: true,
        finished: false,
        content: "",
      });
      recentEncrypts.set(encryptHash, { ts: Date.now(), streamId });

      let core: PluginRuntime | null = null;
      try {
        core = getWecomRuntime();
      } catch (err) {
        logVerbose(target, `runtime not ready, skipping agent processing: ${String(err)}`);
      }
      if (core) {
        const enrichedTarget: WecomWebhookTarget = { ...target, core };
        const eventMsg = {
          ...msg,
          msgtype: "text",
          text: { content: interactionDesc },
        } as WecomInboundMessage;
        startAgentForStream({ target: enrichedTarget, accountId: target.account.accountId, msg: eventMsg, streamId })
          .catch((err) => {
            const state = streams.get(streamId);
            if (state) {
              state.error = err instanceof Error ? err.message : String(err);
              state.content = state.content || `Error: ${state.error}`;
              state.finished = true;
              state.updatedAt = Date.now();
            }
            target.runtime.error?.(`[${target.account.accountId}] wecom agent failed: ${String(err)}`);
          });
      } else {
        const state = streams.get(streamId);
        if (state) {
          state.finished = true;
          state.updatedAt = Date.now();
        }
      }

      return true;
    }
    if (eventtype === "enter_chat") {
      const welcome = target.account.config.welcomeText?.trim();
      const reply = welcome
        ? { msgtype: "text", text: { content: welcome } }
        : {};
      logVerbose(target, "bot event enter_chat reply");
      jsonOk(res, buildEncryptedJsonReply({
        account: target.account,
        plaintextJson: reply,
        nonce,
        timestamp,
      }));
      return true;
    }

    logVerbose(target, "bot event reply empty");
    jsonOk(res, buildEncryptedJsonReply({
      account: target.account,
      plaintextJson: {},
      nonce,
      timestamp,
    }));
    return true;
  }

  const streamId = createStreamId();
  if (msgid) msgidToStreamId.set(msgid, streamId);
  streams.set(streamId, {
    streamId,
    msgid,
    responseUrl: typeof (msg as any).response_url === "string" ? String((msg as any).response_url).trim() : undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    started: false,
    finished: false,
    content: "",
  });
  recentEncrypts.set(encryptHash, { ts: Date.now(), streamId });

  let core: PluginRuntime | null = null;
  try {
    core = getWecomRuntime();
  } catch (err) {
    logVerbose(target, `runtime not ready, skipping agent processing: ${String(err)}`);
  }

  if (core) {
    streams.get(streamId)!.started = true;
    const enrichedTarget: WecomWebhookTarget = { ...target, core };
    startAgentForStream({ target: enrichedTarget, accountId: target.account.accountId, msg, streamId }).catch((err) => {
      const state = streams.get(streamId);
      if (state) {
        state.error = err instanceof Error ? err.message : String(err);
        state.content = state.content || `Error: ${state.error}`;
        state.finished = true;
        state.updatedAt = Date.now();
      }
      target.runtime.error?.(`[${target.account.accountId}] wecom agent failed: ${String(err)}`);
    });
  } else {
    const state = streams.get(streamId);
    if (state) {
      state.finished = true;
      state.updatedAt = Date.now();
    }
  }

  await waitForStreamContent(streamId, 800);
  const state = streams.get(streamId);
  const initialReply = state && (state.content.trim() || state.error)
    ? buildStreamReplyFromState(state)
    : buildStreamPlaceholderReply(streamId);

  logVerbose(
    target,
    `bot initial reply streamId=${streamId} mode=${state && (state.content.trim() || state.error) ? "stream" : "placeholder"}`,
  );
  target.runtime.log?.(`[wecom] bot reply acked streamId=${streamId} msgid=${msgid || "n/a"}`);
  jsonOk(res, buildEncryptedJsonReply({
    account: target.account,
    plaintextJson: initialReply,
    nonce,
    timestamp,
  }));

  return true;
}

function decryptBotEncrypted(account: ResolvedWecomAccount, encrypt: string): string {
  const encodingAESKey = account.encodingAESKey ?? "";
  if (!encodingAESKey) {
    throw new Error("encodingAESKey missing");
  }
  const receiveId = account.receiveId || "";
  try {
    return decryptWecomEncrypted({ encodingAESKey, receiveId, encrypt });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("receiveId mismatch")) {
      throw err;
    }
    // Some WeCom bot callbacks omit receiveId in the encrypted payload.
    return decryptWecomEncrypted({ encodingAESKey, encrypt });
  }
}
