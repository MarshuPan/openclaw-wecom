import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WecomWebhookTarget } from "./monitor.js";

const cleanupExecuted = new Set<string>();

export function resolveExtFromContentType(contentType: string, fallback: string): string {
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

export async function cleanupMediaDir(
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

export function resolveMediaTempDir(target: WecomWebhookTarget): string {
  return target.account.config.media?.tempDir?.trim()
    || join(tmpdir(), "openclaw-wecom");
}

export function resolveMediaMaxBytes(target: WecomWebhookTarget): number | undefined {
  const maxBytes = target.account.config.media?.maxBytes;
  return typeof maxBytes === "number" && maxBytes > 0 ? maxBytes : undefined;
}

export function resolveMediaRetentionMs(target: WecomWebhookTarget): number | undefined {
  const hours = target.account.config.media?.retentionHours;
  return typeof hours === "number" && hours > 0 ? hours * 3600 * 1000 : undefined;
}

export function sanitizeFilename(name: string, fallback: string): string {
  const base = name.split(/[/\\\\]/).pop() ?? "";
  const trimmed = base.trim();
  const safe = trimmed
    .replace(/[^\w.\-() ]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  const finalName = safe.slice(0, 120);
  return finalName || fallback;
}
