export const WECOM_TEXT_BYTE_LIMIT = 2000;

export function markdownToWecomText(markdown: string): string {
  if (!markdown) return markdown;

  let text = markdown;

  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const lines = String(code).trim().split("\n").map((line) => `  ${line}`).join("\n");
    return lang ? `[${lang}]\n${lines}` : lines;
  });

  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/^### (.+)$/gm, "▸ $1");
  text = text.replace(/^## (.+)$/gm, "■ $1");
  text = text.replace(/^# (.+)$/gm, "◆ $1");

  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, "$1");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/\*([^*]+)\*/g, "$1");
  text = text.replace(/___([^_]+)___/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/_([^_]+)_/g, "$1");

  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  text = text.replace(/^[\*\-] /gm, "• ");
  text = text.replace(/^[-*_]{3,}$/gm, "────────────");
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "[图片: $1]");

  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

function getByteLength(str: string): number {
  return Buffer.byteLength(str, "utf8");
}

export function splitWecomText(text: string, byteLimit = WECOM_TEXT_BYTE_LIMIT): string[] {
  if (!text) return [""];
  if (getByteLength(text) <= byteLimit) return [text];

  const chunks: string[] = [];
  let current = "";

  for (const ch of text) {
    const next = current + ch;
    if (getByteLength(next) > byteLimit) {
      if (current) chunks.push(current);
      current = ch;
      continue;
    }
    current = next;
  }

  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [text];
}
