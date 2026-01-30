import type { IncomingMessage, ServerResponse } from "node:http";
import type { WecomWebhookTarget } from "./monitor.js";

export async function handleWecomBotWebhook(params: {
  req: IncomingMessage;
  res: ServerResponse;
  targets: WecomWebhookTarget[];
}): Promise<boolean> {
  const { req, res } = params;

  // TODO: implement intelligent bot (API mode) JSON-encrypted webhook handling
  // - verify signature
  // - decrypt payload
  // - stream placeholder + refresh callbacks
  // - call OpenClaw agent runtime

  if (req.method === "GET" || req.method === "POST") {
    // Skeleton: not implemented yet; return false to allow app handler to try.
    return false;
  }

  res.statusCode = 405;
  res.setHeader("Allow", "GET, POST");
  res.end();
  return true;
}
