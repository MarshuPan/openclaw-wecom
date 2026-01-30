import type { ResolvedWecomAccount } from "./types.js";

export type CommandContext = {
  account: ResolvedWecomAccount;
  fromUser: string;
};

export async function handleCommand(_cmd: string, _ctx: CommandContext): Promise<boolean> {
  // TODO: implement /help /status /clear
  return false;
}
