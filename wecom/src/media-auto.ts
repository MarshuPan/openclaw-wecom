import { readFile, stat, writeFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

import type { WecomAccountConfig } from "./types.js";
import { describeImageWithVision, resolveVisionConfig } from "./media-vision.js";

const DEFAULT_TEXT_EXTENSIONS = ["txt", "md", "log", "csv", "json", "xml", "yaml", "yml"];

export type AutoAudioConfig = {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  prompt?: string;
  timeoutMs?: number;
  maxBytes?: number;
};

export type AutoFileConfig = {
  enabled?: boolean;
  textMaxBytes?: number;
  textMaxChars?: number;
  extensions?: string[];
};

export type AutoVideoConfig = {
  enabled?: boolean;
  ffmpegPath?: string;
  maxBytes?: number;
};

export type ResolvedAutoAudioConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt?: string;
  timeoutMs: number;
  maxBytes?: number;
};

export type ResolvedAutoFileConfig = {
  textMaxBytes: number;
  textMaxChars: number;
  extensions: string[];
};

export type ResolvedAutoVideoConfig = {
  ffmpegPath: string;
  maxBytes?: number;
  mode: "light" | "full";
  frames: number;
  intervalSec: number;
  maxDurationSec: number;
  maxFrames: number;
  includeAudio: boolean;
};

export function resolveAutoAudioConfig(cfg: WecomAccountConfig): ResolvedAutoAudioConfig | null {
  const audio = cfg.media?.auto?.audio;
  if (!cfg.media?.auto?.enabled || !audio?.enabled) return null;
  const baseUrl = audio.baseUrl?.trim() || "";
  const apiKey = audio.apiKey?.trim() || "";
  const model = audio.model?.trim() || "";
  if (!baseUrl || !apiKey || !model) return null;
  return {
    baseUrl,
    apiKey,
    model,
    prompt: audio.prompt?.trim() || undefined,
    timeoutMs: typeof audio.timeoutMs === "number" && audio.timeoutMs > 0 ? audio.timeoutMs : 15000,
    maxBytes: typeof audio.maxBytes === "number" && audio.maxBytes > 0 ? audio.maxBytes : undefined,
  };
}

export function resolveAutoFileConfig(cfg: WecomAccountConfig): ResolvedAutoFileConfig | null {
  const fileCfg = cfg.media?.auto?.file;
  if (!cfg.media?.auto?.enabled || !fileCfg?.enabled) return null;
  const textMaxBytes = typeof fileCfg.textMaxBytes === "number" && fileCfg.textMaxBytes > 0
    ? fileCfg.textMaxBytes
    : 200_000;
  const textMaxChars = typeof fileCfg.textMaxChars === "number" && fileCfg.textMaxChars > 0
    ? fileCfg.textMaxChars
    : 4000;
  const extensions = (fileCfg.extensions && fileCfg.extensions.length > 0
    ? fileCfg.extensions
    : DEFAULT_TEXT_EXTENSIONS).map((ext) => ext.toLowerCase());
  return { textMaxBytes, textMaxChars, extensions };
}

export function resolveAutoVideoConfig(cfg: WecomAccountConfig): ResolvedAutoVideoConfig | null {
  const video = cfg.media?.auto?.video;
  if (!cfg.media?.auto?.enabled || !video?.enabled) return null;
  const mode = video.mode === "full" ? "full" : "light";
  const maxDurationSec = typeof video.maxDurationSec === "number" && video.maxDurationSec > 0
    ? video.maxDurationSec
    : mode === "full" ? 120 : 60;
  const frames = typeof video.frames === "number" && video.frames > 0
    ? video.frames
    : mode === "full" ? 12 : 5;
  const intervalSec = typeof video.intervalSec === "number" && video.intervalSec > 0
    ? video.intervalSec
    : Math.max(1, Math.round(maxDurationSec / Math.max(frames, 1)));
  const maxFrames = typeof video.maxFrames === "number" && video.maxFrames > 0
    ? video.maxFrames
    : mode === "full" ? 30 : frames;
  const includeAudio = video.includeAudio === true;
  return {
    ffmpegPath: video.ffmpegPath?.trim() || "ffmpeg",
    maxBytes: typeof video.maxBytes === "number" && video.maxBytes > 0 ? video.maxBytes : undefined,
    mode,
    frames,
    intervalSec,
    maxDurationSec,
    maxFrames,
    includeAudio,
  };
}

function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const byte of sample) {
    if (byte === 0) return false;
  }
  return true;
}

function isAllowedTextFile(path: string, mimeType: string | undefined, cfg: ResolvedAutoFileConfig): boolean {
  if (mimeType && mimeType.startsWith("text/")) return true;
  const ext = extname(path).replace(".", "").toLowerCase();
  if (!ext) return false;
  return cfg.extensions.includes(ext);
}

export async function extractFileTextPreview(params: {
  path: string;
  mimeType?: string;
  cfg: ResolvedAutoFileConfig;
}): Promise<string | null> {
  const info = await stat(params.path);
  if (info.size > params.cfg.textMaxBytes) return null;
  if (!isAllowedTextFile(params.path, params.mimeType, params.cfg)) return null;
  const buffer = await readFile(params.path);
  if (!looksLikeText(buffer)) return null;
  const text = buffer.toString("utf8").trim();
  if (!text) return null;
  return text.slice(0, params.cfg.textMaxChars);
}

export async function transcribeAudioWithOpenAI(params: {
  cfg: ResolvedAutoAudioConfig;
  buffer: Buffer;
  mimeType?: string;
}): Promise<string | null> {
  if (params.cfg.maxBytes && params.buffer.length > params.cfg.maxBytes) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.cfg.timeoutMs);
  try {
    const form = new FormData();
    const mimeType = params.mimeType || "audio/amr";
    form.append("file", new Blob([params.buffer], { type: mimeType }), `audio.${mimeType.split("/")[1] || "amr"}`);
    form.append("model", params.cfg.model);
    if (params.cfg.prompt) form.append("prompt", params.cfg.prompt);

    const res = await fetch(`${params.cfg.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.cfg.apiKey}`,
      },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      return null;
    }
    const json = await res.json();
    const text = typeof json.text === "string" ? json.text : typeof json?.data?.text === "string" ? json.data.text : "";
    return text.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function runFfmpegExtractFrame(params: {
  ffmpegPath: string;
  videoPath: string;
  framePath: string;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(params.ffmpegPath, [
      "-y",
      "-i",
      params.videoPath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      params.framePath,
    ]);
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code ?? "unknown"}`));
    });
  });
}

async function runFfmpegExtractFrames(params: {
  ffmpegPath: string;
  videoPath: string;
  outputPattern: string;
  fps: number;
  maxDurationSec: number;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(params.ffmpegPath, [
      "-y",
      "-i",
      params.videoPath,
      "-t",
      String(params.maxDurationSec),
      "-vf",
      `fps=${params.fps}`,
      "-q:v",
      "2",
      params.outputPattern,
    ]);
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code ?? "unknown"}`));
    });
  });
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

export async function summarizeVideoWithVision(params: {
  cfg: ResolvedAutoVideoConfig;
  account: WecomAccountConfig;
  videoPath: string;
}): Promise<string | null> {
  const info = await stat(params.videoPath);
  if (params.cfg.maxBytes && info.size > params.cfg.maxBytes) return null;
  const visionConfig = resolveVisionConfig(params.account);
  if (!visionConfig) return null;

  const tempDir = await mkdtemp(join(tmpdir(), "openclaw-wecom-frame-"));
  const framePath = join(tempDir, `${basename(params.videoPath)}.jpg`);
  try {
    const summaries: string[] = [];
    if (params.cfg.mode === "light") {
      const fps = Math.max(0.05, params.cfg.frames / Math.max(params.cfg.maxDurationSec, 1));
      await runFfmpegExtractFrames({
        ffmpegPath: params.cfg.ffmpegPath,
        videoPath: params.videoPath,
        outputPattern: join(tempDir, "frame-%03d.jpg"),
        fps,
        maxDurationSec: params.cfg.maxDurationSec,
      });
      const frames = (await readdir(tempDir))
        .filter((name) => name.startsWith("frame-") && name.endsWith(".jpg"))
        .sort()
        .slice(0, params.cfg.maxFrames);
      for (const frame of frames) {
        const buffer = await readFile(join(tempDir, frame));
        if (!buffer.length) continue;
        const summary = await describeImageWithVision({
          config: visionConfig,
          buffer,
          mimeType: "image/jpeg",
        });
        if (summary) summaries.push(summary);
      }
    } else {
      const fps = Math.max(0.1, 1 / Math.max(params.cfg.intervalSec, 1));
      await runFfmpegExtractFrames({
        ffmpegPath: params.cfg.ffmpegPath,
        videoPath: params.videoPath,
        outputPattern: join(tempDir, "frame-%03d.jpg"),
        fps,
        maxDurationSec: params.cfg.maxDurationSec,
      });
      const frames = (await readdir(tempDir))
        .filter((name) => name.startsWith("frame-") && name.endsWith(".jpg"))
        .sort()
        .slice(0, params.cfg.maxFrames);
      for (const frame of frames) {
        const buffer = await readFile(join(tempDir, frame));
        if (!buffer.length) continue;
        const summary = await describeImageWithVision({
          config: visionConfig,
          buffer,
          mimeType: "image/jpeg",
        });
        if (summary) summaries.push(summary);
      }
    }

    if (summaries.length === 0) return null;
    const unique = Array.from(new Set(summaries.map((s) => s.trim()).filter(Boolean)));
    const maxChars = 1600;
    const lines = unique.slice(0, params.cfg.maxFrames).map((s, idx) => `${idx + 1}. ${s}`);
    const joined = truncateText(lines.join("\n"), maxChars);
    return `关键帧概述（${unique.length}帧）\n${joined}`;
  } catch {
    return null;
  } finally {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup
    }
  }
}
