export type WecomMode = "bot" | "app" | "both";

export type WecomDmConfig = {
  policy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
};

export type WecomBotConfig = {
  token?: string;
  encodingAESKey?: string;
  receiveId?: string;
};

export type WecomAppConfig = {
  corpId?: string;
  corpSecret?: string;
  agentId?: string | number;
  callbackToken?: string;
  callbackAesKey?: string;
};

export type WecomAccountConfig = {
  name?: string;
  enabled?: boolean;
  mode?: WecomMode;

  // Shared settings
  webhookPath?: string;
  welcomeText?: string;
  dm?: WecomDmConfig;

  // Bot API (intelligent bot) settings
  token?: string;
  encodingAESKey?: string;
  receiveId?: string;

  // Internal app settings
  corpId?: string;
  corpSecret?: string;
  agentId?: string | number;
  callbackToken?: string;
  callbackAesKey?: string;
  pushToken?: string;

  // Media handling
  media?: {
    tempDir?: string;
    retentionHours?: number;
    cleanupOnStart?: boolean;
    maxBytes?: number;
    vision?: {
      enabled?: boolean;
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      prompt?: string;
      maxTokens?: number;
      timeoutMs?: number;
      maxBytes?: number;
    };
    auto?: {
      enabled?: boolean;
      file?: {
        enabled?: boolean;
        textMaxBytes?: number;
        textMaxChars?: number;
        extensions?: string[];
      };
      audio?: {
        enabled?: boolean;
        baseUrl?: string;
        apiKey?: string;
        model?: string;
        prompt?: string;
        timeoutMs?: number;
        maxBytes?: number;
      };
      video?: {
        enabled?: boolean;
        ffmpegPath?: string;
        maxBytes?: number;
        mode?: "light" | "full";
        frames?: number;
        intervalSec?: number;
        maxDurationSec?: number;
        maxFrames?: number;
        includeAudio?: boolean;
      };
    };
  };

  // Network behavior
  network?: {
    timeoutMs?: number;
    retries?: number;
    retryDelayMs?: number;
  };

  // If true (default), bot mode can bridge media via app send APIs.
  botMediaBridge?: boolean;

  // Send queue behavior (e.g., /sendfile)
  sendQueue?: {
    intervalMs?: number;
  };

  // Operation logs (optional)
  operations?: {
    logPath?: string;
  };
};

export type WecomConfig = WecomAccountConfig & {
  defaultAccount?: string;
  accounts?: Record<string, WecomAccountConfig>;
};

export type ResolvedWecomAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  mode: WecomMode;
  config: WecomAccountConfig;

  // Bot API
  token?: string;
  encodingAESKey?: string;
  receiveId: string;

  // Internal app
  corpId?: string;
  corpSecret?: string;
  agentId?: number;
  callbackToken?: string;
  callbackAesKey?: string;
};

export type WecomInboundBase = {
  msgid?: string;
  aibotid?: string;
  chattype?: "single" | "group";
  chatid?: string;
  response_url?: string;
  from?: { userid?: string; corpid?: string };
  msgtype?: string;
};

export type WecomInboundText = WecomInboundBase & {
  msgtype: "text";
  text?: { content?: string };
};

export type WecomInboundVoice = WecomInboundBase & {
  msgtype: "voice";
  voice?: { content?: string };
};

export type WecomInboundStreamRefresh = WecomInboundBase & {
  msgtype: "stream";
  stream?: { id?: string };
};

export type WecomInboundEvent = WecomInboundBase & {
  msgtype: "event";
  create_time?: number;
  event?: {
    eventtype?: string;
    [key: string]: unknown;
  };
};

export type WecomInboundMessage =
  | WecomInboundText
  | WecomInboundVoice
  | WecomInboundStreamRefresh
  | WecomInboundEvent
  | (WecomInboundBase & Record<string, unknown>);

export type WecomNormalizedMessage = {
  id?: string;
  type: "text" | "image" | "voice" | "file" | "video" | "link" | "event" | "unknown";
  text?: string;
  mediaId?: string;
  mediaUrl?: string;
  chatId?: string;
  userId?: string;
  isGroup?: boolean;
  raw?: unknown;
};
