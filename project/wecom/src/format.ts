export const WECOM_TEXT_BYTE_LIMIT = 2000;

export function markdownToWecomText(markdown: string): string {
  // TODO: implement markdown to plain-text conversion (see OpenClaw-Wechat)
  return markdown;
}

export function splitWecomText(text: string, byteLimit = WECOM_TEXT_BYTE_LIMIT): string[] {
  // TODO: implement UTF-8 byte length chunking
  if (!text) return [""];
  return [text];
}
