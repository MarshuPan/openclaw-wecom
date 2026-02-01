import { splitWecomText } from "./format.js";
import type { ResolvedWecomAccount } from "./types.js";

export type WecomTokenState = {
  token: string | null;
  expiresAt: number;
  refreshPromise: Promise<string> | null;
};

class RateLimiter {
  private maxConcurrent: number;
  private minInterval: number;
  private running: number;
  private queue: Array<{ fn: () => Promise<any>; resolve: (v: any) => void; reject: (e: any) => void }>;
  private lastExecution: number;

  constructor({ maxConcurrent = 3, minInterval = 200 } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.minInterval = minInterval;
    this.running = 0;
    this.queue = [];
    this.lastExecution = 0;
  }

  execute<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const now = Date.now();
    const waitTime = Math.max(0, this.lastExecution + this.minInterval - now);

    if (waitTime > 0) {
      setTimeout(() => this.processQueue(), waitTime);
      return;
    }

    this.running += 1;
    this.lastExecution = Date.now();

    const { fn, resolve, reject } = this.queue.shift()!;

    try {
      const result = await fn();
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      this.running -= 1;
      this.processQueue();
    }
  }
}

const accessTokenCaches = new Map<string, WecomTokenState>();
const apiLimiter = new RateLimiter({ maxConcurrent: 3, minInterval: 200 });
export const MEDIA_TOO_LARGE_ERROR = "MEDIA_TOO_LARGE";

function ensureAppConfig(account: ResolvedWecomAccount): { corpId: string; corpSecret: string; agentId: number } {
  const corpId = account.corpId ?? "";
  const corpSecret = account.corpSecret ?? "";
  const agentId = account.agentId ?? 0;
  if (!corpId || !corpSecret || !agentId) {
    throw new Error("WeCom app not configured (corpId/corpSecret/agentId required)");
  }
  return { corpId, corpSecret, agentId };
}

function resolveNetworkConfig(account: ResolvedWecomAccount): { timeoutMs: number; retries: number; retryDelayMs: number } {
  const cfg = account.config.network ?? {};
  const timeoutMs = typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0 ? cfg.timeoutMs : 15000;
  const retries = typeof cfg.retries === "number" && cfg.retries >= 0 ? cfg.retries : 2;
  const retryDelayMs = typeof cfg.retryDelayMs === "number" && cfg.retryDelayMs >= 0 ? cfg.retryDelayMs : 300;
  return { timeoutMs, retries, retryDelayMs };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(account: ResolvedWecomAccount, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const { timeoutMs, retries, retryDelayMs } = resolveNetworkConfig(account);
  let attempt = 0;
  let lastErr: unknown;
  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await apiLimiter.execute(() => fetch(input, { ...init, signal: controller.signal }));
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt >= retries) break;
      await sleep(retryDelayMs * Math.max(1, attempt + 1));
    }
    attempt += 1;
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function resolveContentLength(res: Response): number | null {
  const raw = res.headers.get("content-length");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function ensureNotTooLarge(res: Response, maxBytes?: number): void {
  if (!maxBytes || maxBytes <= 0) return;
  const length = resolveContentLength(res);
  if (length && length > maxBytes) {
    const err = new Error(`${MEDIA_TOO_LARGE_ERROR}: content-length ${length} > limit ${maxBytes}`);
    (err as { code?: string }).code = MEDIA_TOO_LARGE_ERROR;
    throw err;
  }
}

export async function getWecomAccessToken(account: ResolvedWecomAccount): Promise<string> {
  const { corpId, corpSecret } = ensureAppConfig(account);
  const cacheKey = corpId;
  let cache = accessTokenCaches.get(cacheKey);

  if (!cache) {
    cache = { token: null, expiresAt: 0, refreshPromise: null };
    accessTokenCaches.set(cacheKey, cache);
  }

  const now = Date.now();
  if (cache.token && cache.expiresAt > now + 60000) {
    return cache.token;
  }

  if (cache.refreshPromise) {
    return cache.refreshPromise;
  }

  cache.refreshPromise = (async () => {
    try {
      const tokenUrl = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`;
      const tokenRes = await fetchWithRetry(account, tokenUrl);
      const tokenJson = await tokenRes.json();
      if (!tokenJson?.access_token) {
        throw new Error(`WeCom gettoken failed: ${JSON.stringify(tokenJson)}`);
      }

      cache.token = tokenJson.access_token;
      cache.expiresAt = Date.now() + (tokenJson.expires_in || 7200) * 1000;

      return cache.token;
    } finally {
      cache.refreshPromise = null;
    }
  })();

  return cache.refreshPromise;
}

async function sendWecomTextSingle(params: {
  account: ResolvedWecomAccount;
  toUser: string;
  chatId?: string;
  text: string;
}): Promise<void> {
  const { account, toUser, chatId, text } = params;
  const { agentId } = ensureAppConfig(account);
  const accessToken = await getWecomAccessToken(account);
  const useChat = Boolean(chatId);
  const sendUrl = useChat
    ? `https://qyapi.weixin.qq.com/cgi-bin/appchat/send?access_token=${encodeURIComponent(accessToken)}`
    : `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;

  const body = useChat
    ? { chatid: chatId, msgtype: "text", text: { content: text } }
    : { touser: toUser, msgtype: "text", agentid: agentId, text: { content: text } };

  const sendRes = await fetchWithRetry(account, sendUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const sendJson = await sendRes.json();
  if (sendJson?.errcode !== 0) {
    throw new Error(`WeCom message/send failed: ${JSON.stringify(sendJson)}`);
  }
}

export async function sendWecomText(params: {
  account: ResolvedWecomAccount;
  toUser: string;
  chatId?: string;
  text: string;
}): Promise<void> {
  const { account, toUser, chatId, text } = params;
  const chunks = splitWecomText(text);
  for (const chunk of chunks) {
    if (!chunk) continue;
    await sendWecomTextSingle({ account, toUser, chatId, text: chunk });
  }
}

export async function uploadWecomMedia(params: {
  account: ResolvedWecomAccount;
  type: "image" | "voice" | "video" | "file";
  buffer: Buffer;
  filename: string;
}): Promise<string> {
  const { account, type, buffer, filename } = params;
  const accessToken = await getWecomAccessToken(account);
  const uploadUrl = `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${encodeURIComponent(accessToken)}&type=${encodeURIComponent(type)}`;

  const form = new FormData();
  form.append("media", new Blob([buffer]), filename);

  const res = await fetchWithRetry(account, uploadUrl, {
    method: "POST",
    body: form,
  });
  const json = await res.json();
  if (!json?.media_id) {
    throw new Error(`WeCom media upload failed: ${JSON.stringify(json)}`);
  }
  return json.media_id;
}

export async function sendWecomImage(params: {
  account: ResolvedWecomAccount;
  toUser: string;
  chatId?: string;
  mediaId: string;
}): Promise<void> {
  const { account, toUser, chatId, mediaId } = params;
  const { agentId } = ensureAppConfig(account);
  const accessToken = await getWecomAccessToken(account);
  const useChat = Boolean(chatId);
  const sendUrl = useChat
    ? `https://qyapi.weixin.qq.com/cgi-bin/appchat/send?access_token=${encodeURIComponent(accessToken)}`
    : `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;

  const body = useChat
    ? { chatid: chatId, msgtype: "image", image: { media_id: mediaId } }
    : { touser: toUser, msgtype: "image", agentid: agentId, image: { media_id: mediaId } };

  const sendRes = await fetchWithRetry(account, sendUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const sendJson = await sendRes.json();
  if (sendJson?.errcode !== 0) {
    throw new Error(`WeCom image send failed: ${JSON.stringify(sendJson)}`);
  }
}

export async function sendWecomVoice(params: {
  account: ResolvedWecomAccount;
  toUser: string;
  chatId?: string;
  mediaId: string;
}): Promise<void> {
  const { account, toUser, chatId, mediaId } = params;
  const { agentId } = ensureAppConfig(account);
  const accessToken = await getWecomAccessToken(account);
  const useChat = Boolean(chatId);
  const sendUrl = useChat
    ? `https://qyapi.weixin.qq.com/cgi-bin/appchat/send?access_token=${encodeURIComponent(accessToken)}`
    : `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;

  const body = useChat
    ? { chatid: chatId, msgtype: "voice", voice: { media_id: mediaId } }
    : { touser: toUser, msgtype: "voice", agentid: agentId, voice: { media_id: mediaId } };

  const sendRes = await fetchWithRetry(account, sendUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const sendJson = await sendRes.json();
  if (sendJson?.errcode !== 0) {
    throw new Error(`WeCom voice send failed: ${JSON.stringify(sendJson)}`);
  }
}

export async function sendWecomVideo(params: {
  account: ResolvedWecomAccount;
  toUser: string;
  chatId?: string;
  mediaId: string;
  title?: string;
  description?: string;
}): Promise<void> {
  const { account, toUser, chatId, mediaId, title, description } = params;
  const { agentId } = ensureAppConfig(account);
  const accessToken = await getWecomAccessToken(account);
  const useChat = Boolean(chatId);
  const sendUrl = useChat
    ? `https://qyapi.weixin.qq.com/cgi-bin/appchat/send?access_token=${encodeURIComponent(accessToken)}`
    : `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;

  const video = { media_id: mediaId, title: title ?? "Video", description: description ?? "" };
  const body = useChat
    ? { chatid: chatId, msgtype: "video", video }
    : { touser: toUser, msgtype: "video", agentid: agentId, video };

  const sendRes = await fetchWithRetry(account, sendUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const sendJson = await sendRes.json();
  if (sendJson?.errcode !== 0) {
    throw new Error(`WeCom video send failed: ${JSON.stringify(sendJson)}`);
  }
}

export async function sendWecomFile(params: {
  account: ResolvedWecomAccount;
  toUser: string;
  chatId?: string;
  mediaId: string;
}): Promise<void> {
  const { account, toUser, chatId, mediaId } = params;
  const { agentId } = ensureAppConfig(account);
  const accessToken = await getWecomAccessToken(account);
  const useChat = Boolean(chatId);
  const sendUrl = useChat
    ? `https://qyapi.weixin.qq.com/cgi-bin/appchat/send?access_token=${encodeURIComponent(accessToken)}`
    : `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;

  const body = useChat
    ? { chatid: chatId, msgtype: "file", file: { media_id: mediaId } }
    : { touser: toUser, msgtype: "file", agentid: agentId, file: { media_id: mediaId } };

  const sendRes = await fetchWithRetry(account, sendUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const sendJson = await sendRes.json();
  if (sendJson?.errcode !== 0) {
    throw new Error(`WeCom file send failed: ${JSON.stringify(sendJson)}`);
  }
}

export async function downloadWecomMedia(params: {
  account: ResolvedWecomAccount;
  mediaId: string;
  maxBytes?: number;
}): Promise<{ buffer: Buffer; contentType: string } > {
  const { account, mediaId, maxBytes } = params;
  const accessToken = await getWecomAccessToken(account);
  const mediaUrl = `https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=${encodeURIComponent(accessToken)}&media_id=${encodeURIComponent(mediaId)}`;

  const res = await fetchWithRetry(account, mediaUrl);
  if (!res.ok) {
    throw new Error(`Failed to download media: ${res.status}`);
  }

  const contentType = res.headers.get("content-type") || "";
  ensureNotTooLarge(res, maxBytes);
  if (contentType.includes("application/json")) {
    const json = await res.json();
    throw new Error(`WeCom media download failed: ${JSON.stringify(json)}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

export async function fetchMediaFromUrl(
  url: string,
  account?: ResolvedWecomAccount,
  maxBytes?: number,
): Promise<{ buffer: Buffer; contentType: string } > {
  const res = account ? await fetchWithRetry(account, url) : await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch media from URL: ${res.status}`);
  }
  ensureNotTooLarge(res, maxBytes);
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  return { buffer, contentType };
}
