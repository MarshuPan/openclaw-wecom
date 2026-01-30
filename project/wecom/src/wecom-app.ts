import type { IncomingMessage, ServerResponse } from "node:http";
import type { WecomWebhookTarget } from "./monitor.js";

export async function handleWecomAppWebhook(params: {
  req: IncomingMessage;
  res: ServerResponse;
  targets: WecomWebhookTarget[];
}): Promise<boolean> {
  const { req, res } = params;

  // TODO: implement internal app XML-encrypted webhook handling
  // - URL verification (echostr)
  // - signature verification
  // - decrypt XML
  // - ACK 200 quickly
  // - async agent processing + proactive send

  if (req.method === "GET" || req.method === "POST") {
    // Skeleton: not implemented yet.
    return false;
  }

  res.statusCode = 405;
  res.setHeader("Allow", "GET, POST");
  res.end();
  return true;
}
