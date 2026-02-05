import type {
  ChannelAccountSnapshot,
  ChannelPlugin,
  ClawdbotConfig,
} from "openclaw/plugin-sdk";
import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk";

import { listWecomAccountIds, resolveDefaultWecomAccountId, resolveWecomAccount } from "./accounts.js";
import { WecomConfigSchema } from "./config-schema.js";
import type { ResolvedWecomAccount } from "./types.js";
import { registerWecomWebhookTarget } from "./monitor.js";

const meta = {
  id: "wecom",
  label: "WeCom",
  selectionLabel: "WeCom (plugin)",
  docsPath: "/channels/wecom",
  docsLabel: "wecom",
  blurb: "Enterprise WeCom: bot API + internal app (dual mode).",
  aliases: ["wechatwork", "wework", "qywx", "企微", "企业微信"],
  order: 85,
  quickstartAllowFrom: true,
};

function normalizeWecomMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^(wecom|wechatwork|wework|qywx):/i, "").trim() || undefined;
}

export const wecomPlugin: ChannelPlugin<ResolvedWecomAccount> = {
  id: "wecom",
  meta,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.wecom"] },
  configSchema: buildChannelConfigSchema(WecomConfigSchema),
  config: {
    listAccountIds: (cfg) => listWecomAccountIds(cfg as ClawdbotConfig),
    resolveAccount: (cfg, accountId) => resolveWecomAccount({ cfg: cfg as ClawdbotConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultWecomAccountId(cfg as ClawdbotConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as ClawdbotConfig,
        sectionKey: "wecom",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as ClawdbotConfig,
        sectionKey: "wecom",
        clearBaseFields: [
          "name",
          "webhookPath",
          "token",
          "encodingAESKey",
          "receiveId",
          "corpId",
          "corpSecret",
          "agentId",
          "callbackToken",
          "callbackAesKey",
          "welcomeText",
        ],
        accountId,
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      webhookPath: account.config.webhookPath ?? "/wecom",
    }),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveWecomAccount({ cfg: cfg as ClawdbotConfig, accountId });
      return (account.config.dm?.allowFrom ?? []).map((entry) => String(entry));
    },
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean((cfg as ClawdbotConfig).channels?.wecom?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath ? `channels.wecom.accounts.${resolvedAccountId}.` : "channels.wecom.";
      return {
        policy: account.config.dm?.policy ?? "pairing",
        allowFrom: (account.config.dm?.allowFrom ?? []).map((entry) => String(entry)),
        policyPath: `${basePath}dm.policy`,
        allowFromPath: `${basePath}dm.allowFrom`,
        approveHint: formatPairingApproveHint("wecom"),
        normalizeEntry: (raw) => raw.trim().toLowerCase(),
      };
    },
  },
  groups: {
    resolveRequireMention: () => true,
  },
  threading: {
    resolveReplyToMode: () => "off",
  },
  messaging: {
    normalizeTarget: normalizeWecomMessagingTarget,
    targetResolver: {
      looksLikeId: (raw) => Boolean(raw.trim()),
      hint: "<userid|chatid>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunkerMode: "text",
    textChunkLimit: 20480,
    sendText: async ({ cfg, to, text, accountId }) => {
      try {
        const resolvedAccount = accountId ?? DEFAULT_ACCOUNT_ID;
        const account = resolveWecomAccount({ cfg: cfg as ClawdbotConfig, accountId: resolvedAccount });
        let target = typeof to === "string" ? to.trim() : "";
        if (target.toLowerCase().startsWith("wecom:")) {
          target = target.slice("wecom:".length).trim();
        }
        if (!target) {
          return {
            channel: "wecom",
            ok: false,
            messageId: "",
            error: new Error("WeCom outbound requires --to <userid|chatid>."),
          };
        }
        if (!account.corpId || !account.corpSecret || !account.agentId) {
          return {
            channel: "wecom",
            ok: false,
            messageId: "",
            error: new Error("WeCom app outbound requires corpId/corpSecret/agentId (App mode)."),
          };
        }
        const { sendWecomText } = await import("./wecom-api.js");
        const lower = target.toLowerCase();
        const chatPrefixes = ["chat:", "chatid:", "group:"];
        const matchedPrefix = chatPrefixes.find((prefix) => lower.startsWith(prefix));
        let res : any;
        if (matchedPrefix) {
          const chatId = target.slice(matchedPrefix.length).trim();
          if (!chatId) {
            return {
              channel: "wecom",
              ok: false,
              messageId: "",
              error: new Error("WeCom outbound requires chatId after chat:/chatid:/group: prefix."),
            };
          }
          res = await sendWecomText({
            account,
            toUser: "",
            chatId,
            text: String(text ?? ""),
          });
        } else {
          res = await sendWecomText({
            account,
            toUser: target,
            text: String(text ?? ""),
          });
        }
        return {
          channel: "wecom",
          ok: true,
          messageId: res ? res.msgid : "",
        };
      } catch (err) {
        return {
          channel: "wecom",
          ok: false,
          messageId: "",
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
      try {
        const resolvedAccount = accountId ?? DEFAULT_ACCOUNT_ID;
        const account = resolveWecomAccount({ cfg: cfg as ClawdbotConfig, accountId: resolvedAccount });
        let target = typeof to === "string" ? to.trim() : "";
        if (target.toLowerCase().startsWith("wecom:")) {
          target = target.slice("wecom:".length).trim();
        }
        if (!target) {
          return {
            channel: "wecom",
            ok: false,
            messageId: "",
            error: new Error("WeCom outbound requires --to <userid|chatid>."),
          };
        }
        if (!account.corpId || !account.corpSecret || !account.agentId) {
          return {
            channel: "wecom",
            ok: false,
            messageId: "",
            error: new Error("WeCom app outbound requires corpId/corpSecret/agentId (App mode)."),
          };
        }
        if (!mediaUrl) {
          return {
            channel: "wecom",
            ok: false,
            messageId: "",
            error: new Error("WeCom sendMedia requires mediaUrl."),
          };
        }
        const { uploadWecomMedia, sendWecomMedia, sendWecomText } = await import("./wecom-api.js");
        const fs = await import("fs");
        const path = await import("path");

        const lower = target.toLowerCase();
        const chatPrefixes = ["chat:", "chatid:", "group:"];
        const matchedPrefix = chatPrefixes.find((prefix) => lower.startsWith(prefix));
        const chatId = matchedPrefix ? target.slice(matchedPrefix.length).trim() : undefined;
        const toUser = matchedPrefix ? "" : target;

        let buffer: Buffer;
        let filename: string;
        if (mediaUrl.startsWith("file://")) {
          const filePath = mediaUrl.slice(7);
          buffer = fs.readFileSync(filePath);
          filename = path.basename(filePath);
        } else if (mediaUrl.startsWith("/") || /^[a-zA-Z]:/.test(mediaUrl)) {
          buffer = fs.readFileSync(mediaUrl);
          filename = path.basename(mediaUrl);
        } else {
          const res = await fetch(mediaUrl);
          if (!res.ok) {
            throw new Error(`Failed to fetch media: ${res.status} ${res.statusText}`);
          }
          buffer = Buffer.from(await res.arrayBuffer());
          const urlPath = new URL(mediaUrl).pathname;
          filename = path.basename(urlPath) || "media";
        }

        const ext = path.extname(filename).toLowerCase();
        let mediaType: "image" | "voice" | "video" | "file" = "file";
        if ([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"].includes(ext)) {
          mediaType = "image";
        } else if ([".amr", ".mp3", ".wav", ".m4a", ".ogg"].includes(ext)) {
          mediaType = "voice";
        } else if ([".mp4", ".mov", ".avi", ".mkv", ".webm"].includes(ext)) {
          mediaType = "video";
        }

        const mediaId = await uploadWecomMedia({ account, type: mediaType, buffer, filename });
        await sendWecomMedia({ account, toUser, chatId, mediaId, mediaType });

        if (text) {
          await sendWecomText({ account, toUser, chatId, text: String(text) });
        }

        return {
          channel: "wecom",
          ok: true,
          messageId: "",
        };
      } catch (err) {
        return {
          channel: "wecom",
          ok: false,
          messageId: "",
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      webhookPath: snapshot.webhookPath ?? null,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      lastInboundAt: snapshot.lastInboundAt ?? null,
      lastOutboundAt: snapshot.lastOutboundAt ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async () => ({ ok: true }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      webhookPath: account.config.webhookPath ?? "/wecom",
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      dmPolicy: account.config.dm?.policy ?? "pairing",
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.configured) {
        ctx.log?.warn(`[${account.accountId}] wecom not configured; skipping webhook registration`);
        ctx.setStatus({ accountId: account.accountId, running: false, configured: false });
        return { stop: () => {} };
      }
      const path = (account.config.webhookPath ?? "/wecom").trim();
      const pushPath = path.endsWith("/") ? `${path}push` : `${path}/push`;
      const unregister = registerWecomWebhookTarget({
        account,
        config: ctx.cfg as ClawdbotConfig,
        runtime: ctx.runtime,
        core: ({} as unknown) as any,
        path,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
      const unregisterPush = registerWecomWebhookTarget({
        account,
        config: ctx.cfg as ClawdbotConfig,
        runtime: ctx.runtime,
        core: ({} as unknown) as any,
        path: pushPath,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
      ctx.log?.info(`[${account.accountId}] wecom webhook registered at ${path}`);
      ctx.log?.info(`[${account.accountId}] wecom push endpoint registered at ${pushPath}`);
      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        configured: true,
        webhookPath: path,
        lastStartAt: Date.now(),
      });
      return {
        stop: () => {
          unregister();
          unregisterPush();
          ctx.setStatus({
            accountId: account.accountId,
            running: false,
            lastStopAt: Date.now(),
          });
        },
      };
    },
    stopAccount: async (ctx) => {
      ctx.setStatus({
        accountId: ctx.account.accountId,
        running: false,
        lastStopAt: Date.now(),
      });
    },
  },
};
