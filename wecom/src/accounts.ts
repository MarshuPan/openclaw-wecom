import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";

import type { ResolvedWecomAccount, WecomAccountConfig, WecomConfig, WecomMode } from "./types.js";

function resolveEnvValue(cfg: ClawdbotConfig, name: string): string | undefined {
  const envVars = (cfg as any)?.env?.vars ?? {};
  const fromCfg = envVars[name];
  if (fromCfg != null && String(fromCfg).trim() !== "") return String(fromCfg).trim();
  const fromProcess = process.env[name];
  if (fromProcess != null && fromProcess.trim() !== "") return fromProcess.trim();
  return undefined;
}

function resolveAccountEnv(cfg: ClawdbotConfig, accountId: string, key: string): string | undefined {
  const prefix = accountId === DEFAULT_ACCOUNT_ID ? "WECOM" : `WECOM_${accountId.toUpperCase()}`;
  return resolveEnvValue(cfg, `${prefix}_${key}`);
}

function listConfiguredAccountIds(cfg: ClawdbotConfig): string[] {
  const accounts = (cfg.channels?.wecom as WecomConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  return Object.keys(accounts).filter(Boolean);
}

export function listWecomAccountIds(cfg: ClawdbotConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
  return ids.sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultWecomAccountId(cfg: ClawdbotConfig): string {
  const wecomConfig = cfg.channels?.wecom as WecomConfig | undefined;
  if (wecomConfig?.defaultAccount?.trim()) return wecomConfig.defaultAccount.trim();
  const ids = listWecomAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(cfg: ClawdbotConfig, accountId: string): WecomAccountConfig | undefined {
  const accounts = (cfg.channels?.wecom as WecomConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  return accounts[accountId] as WecomAccountConfig | undefined;
}

function mergeWecomAccountConfig(cfg: ClawdbotConfig, accountId: string): WecomAccountConfig {
  const raw = (cfg.channels?.wecom ?? {}) as WecomConfig;
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = raw;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function resolveMode(raw?: string): WecomMode {
  if (raw === "bot" || raw === "app" || raw === "both") return raw;
  return "both";
}

export function resolveWecomAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedWecomAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = (params.cfg.channels?.wecom as WecomConfig | undefined)?.enabled !== false;
  const merged = mergeWecomAccountConfig(params.cfg, accountId);
  const enabled = baseEnabled && merged.enabled !== false;

  const token = merged.token?.trim()
    || resolveAccountEnv(params.cfg, accountId, "TOKEN")
    || undefined;
  const encodingAESKey = merged.encodingAESKey?.trim()
    || resolveAccountEnv(params.cfg, accountId, "ENCODING_AES_KEY")
    || undefined;
  const receiveId = merged.receiveId?.trim()
    || resolveAccountEnv(params.cfg, accountId, "RECEIVE_ID")
    || "";

  const corpId = merged.corpId?.trim()
    || resolveAccountEnv(params.cfg, accountId, "CORP_ID")
    || undefined;
  const corpSecret = merged.corpSecret?.trim()
    || resolveAccountEnv(params.cfg, accountId, "CORP_SECRET")
    || undefined;
  const agentIdRaw = merged.agentId != null ? String(merged.agentId) : resolveAccountEnv(params.cfg, accountId, "AGENT_ID");
  const agentId = agentIdRaw != null ? Number(agentIdRaw) : undefined;
  const callbackToken = merged.callbackToken?.trim()
    || resolveAccountEnv(params.cfg, accountId, "CALLBACK_TOKEN")
    || undefined;
  const callbackAesKey = merged.callbackAesKey?.trim()
    || resolveAccountEnv(params.cfg, accountId, "CALLBACK_AES_KEY")
    || undefined;
  const webhookPath = merged.webhookPath?.trim()
    || resolveAccountEnv(params.cfg, accountId, "WEBHOOK_PATH")
    || undefined;

  const configuredBot = Boolean(token && encodingAESKey);
  const configuredApp = Boolean(corpId && corpSecret && agentId);
  const configured = configuredBot || configuredApp;

  const mode = resolveMode(merged.mode);

  const mergedConfig: WecomAccountConfig = {
    ...merged,
    webhookPath,
    token,
    encodingAESKey,
    receiveId,
    corpId,
    corpSecret,
    agentId,
    callbackToken,
    callbackAesKey,
  };

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    configured,
    mode,
    token,
    encodingAESKey,
    receiveId,
    corpId,
    corpSecret,
    agentId,
    callbackToken,
    callbackAesKey,
    config: mergedConfig,
  };
}

export function listEnabledWecomAccounts(cfg: ClawdbotConfig): ResolvedWecomAccount[] {
  return listWecomAccountIds(cfg)
    .map((accountId) => resolveWecomAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
