import type { ResolvedWecomAccount } from "./types.js";

export type WecomTokenState = {
  token: string | null;
  expiresAt: number;
  refreshPromise: Promise<string> | null;
};

export async function getWecomAccessToken(_account: ResolvedWecomAccount): Promise<string> {
  // TODO: implement access_token cache + refresh (per corpId)
  throw new Error("getWecomAccessToken not implemented");
}

export async function sendWecomText(params: {
  account: ResolvedWecomAccount;
  toUser: string;
  text: string;
}): Promise<void> {
  const { account, toUser, text } = params;
  void account;
  void toUser;
  void text;
  // TODO: implement message/send text API
  throw new Error("sendWecomText not implemented");
}

export async function uploadWecomMedia(params: {
  account: ResolvedWecomAccount;
  type: "image" | "voice" | "video" | "file";
  buffer: Buffer;
  filename: string;
}): Promise<string> {
  const { account, type, buffer, filename } = params;
  void account;
  void type;
  void buffer;
  void filename;
  // TODO: implement media upload API
  throw new Error("uploadWecomMedia not implemented");
}
