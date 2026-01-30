import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

const dmSchema = z
  .object({
    enabled: z.boolean().optional(),
    policy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
    allowFrom: z.array(allowFromEntry).optional(),
  })
  .optional();

const accountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  mode: z.enum(["bot", "app", "both"]).optional(),
  webhookPath: z.string().optional(),
  welcomeText: z.string().optional(),
  dm: dmSchema,

  // Bot API
  token: z.string().optional(),
  encodingAESKey: z.string().optional(),
  receiveId: z.string().optional(),

  // Internal app
  corpId: z.string().optional(),
  corpSecret: z.string().optional(),
  agentId: z.union([z.string(), z.number()]).optional(),
  callbackToken: z.string().optional(),
  callbackAesKey: z.string().optional(),
});

export const WecomConfigSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  mode: z.enum(["bot", "app", "both"]).optional(),
  webhookPath: z.string().optional(),
  welcomeText: z.string().optional(),
  dm: dmSchema,

  token: z.string().optional(),
  encodingAESKey: z.string().optional(),
  receiveId: z.string().optional(),

  corpId: z.string().optional(),
  corpSecret: z.string().optional(),
  agentId: z.union([z.string(), z.number()]).optional(),
  callbackToken: z.string().optional(),
  callbackAesKey: z.string().optional(),

  defaultAccount: z.string().optional(),
  accounts: z.object({}).catchall(accountSchema).optional(),
});
