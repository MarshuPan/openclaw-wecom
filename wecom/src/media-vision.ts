import type { WecomAccountConfig } from "./types.js";

export type VisionConfig = {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  prompt?: string;
  maxTokens?: number;
  timeoutMs?: number;
  maxBytes?: number;
};

function resolveBaseUrl(raw?: string): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (value.endsWith("/v1")) return value;
  return `${value.replace(/\/+$/, "")}/v1`;
}

export function resolveVisionConfig(accountConfig: WecomAccountConfig): VisionConfig | null {
  const vision = accountConfig.media?.vision;
  if (!vision?.enabled) return null;

  const baseUrl = resolveBaseUrl(
    vision.baseUrl
      || process.env.OPENAI_BASE_URL
      || process.env.OPENAI_API_BASE
      || process.env.OPENAI_ENDPOINT,
  );
  const apiKey = vision.apiKey || process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
  if (!baseUrl || !apiKey) return null;

  return {
    enabled: true,
    baseUrl,
    apiKey,
    model: vision.model || process.env.OPENAI_MODEL || "gpt-4o-mini",
    prompt: vision.prompt
      || "请描述图片内容并尽量提取可见文字。输出简洁中文要点。",
    maxTokens: typeof vision.maxTokens === "number" ? vision.maxTokens : 400,
    timeoutMs: typeof vision.timeoutMs === "number" ? vision.timeoutMs : 15000,
    maxBytes: typeof vision.maxBytes === "number" ? vision.maxBytes : undefined,
  };
}

export async function describeImageWithVision(params: {
  config: VisionConfig;
  buffer: Buffer;
  mimeType: string;
}): Promise<string | null> {
  const { config, buffer, mimeType } = params;
  if (!config.enabled || !config.baseUrl || !config.apiKey) return null;

  if (config.maxBytes && buffer.length > config.maxBytes) {
    return null;
  }

  const imageBase64 = buffer.toString("base64");
  const payload = {
    model: config.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: config.prompt },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
        ],
      },
    ],
    max_tokens: config.maxTokens ?? 400,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 15000);
    try {
      const res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        continue;
      }
      const data = await res.json() as any;
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        continue;
      }
      const trimmed = content.trim();
      if (!trimmed) continue;
      return trimmed;
    } catch {
      // retry once
    } finally {
      clearTimeout(timeout);
    }
  }

  return null;
}
