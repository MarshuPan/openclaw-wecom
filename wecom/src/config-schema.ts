import { z } from "zod";

type JsonSchemaCapable = {
  toJSONSchema?: () => unknown;
};

function ensureJsonSchema<T extends JsonSchemaCapable>(schema: T): T {
  if (typeof schema.toJSONSchema === "function") return schema;
  return Object.assign(schema, {
    // Fallback for runtimes that expect Zod toJSONSchema.
    toJSONSchema: () => ({ type: "object" }),
  });
}

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

  media: z.object({
    tempDir: z.string().optional(),
    retentionHours: z.number().optional(),
    cleanupOnStart: z.boolean().optional(),
    maxBytes: z.number().optional(),
  }).optional(),

  network: z.object({
    timeoutMs: z.number().optional(),
    retries: z.number().optional(),
    retryDelayMs: z.number().optional(),
  }).optional(),

  botMediaBridge: z.boolean().optional(),
});

export const WecomConfigSchema = ensureJsonSchema(z.object({
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

  media: z.object({
    tempDir: z.string().optional(),
    retentionHours: z.number().optional(),
    cleanupOnStart: z.boolean().optional(),
    maxBytes: z.number().optional(),
  }).optional(),

  network: z.object({
    timeoutMs: z.number().optional(),
    retries: z.number().optional(),
    retryDelayMs: z.number().optional(),
  }).optional(),

  botMediaBridge: z.boolean().optional(),

  defaultAccount: z.string().optional(),
  accounts: z.object({}).catchall(accountSchema).optional(),
}));
