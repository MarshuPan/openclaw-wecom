# OpenClaw WeCom Plugin (Dual Mode)

English | [中文](README.zh.md)

OpenClaw WeCom plugin supporting **Bot API mode** and **Internal App mode** with multi-account, media, and group chat.

> `docs/TECHNICAL.md` is the source of truth. Read it before development.

## Features
- Dual mode: Bot API (JSON callback + stream) / App (XML callback + ACK + proactive send)
- Multi-account: `channels.wecom.accounts`
- Message types: text / image / voice / video / file (send & receive)
- Commands: `/help`, `/status`, `/clear`
- Stability: signature verification, AES decrypt, token cache, rate limit & retries
- Group chat: uses `appchat/send` when `chatId` is present

## Install
### npm
```bash
openclaw plugins install @marshulll/openclaw-wecom
openclaw plugins enable openclaw-wecom
openclaw gateway restart
```

### Local path
```bash
openclaw plugins install --link /path/to/openclaw-wecom
openclaw plugins enable openclaw-wecom
openclaw gateway restart
```

## Configuration
Write config to `~/.openclaw/openclaw.json`.  
Recommended: use main config only; env vars are fallback.

Minimal example: `docs/wecom.config.example.json`  
Full example: `docs/wecom.config.full.example.json`  
Install guide: `docs/INSTALL.md`

### Minimal config
```json5
{
  "channels": {
    "wecom": {
      "enabled": true,
      "mode": "both",
      "webhookPath": "/wecom",
      "token": "BOT_TOKEN",
      "encodingAESKey": "BOT_AES",
      "receiveId": "BOT_ID",
      "corpId": "CORP_ID",
      "corpSecret": "CORP_SECRET",
      "agentId": 1000001,
      "callbackToken": "CALLBACK_TOKEN",
      "callbackAesKey": "CALLBACK_AES"
    }
  }
}
```

### Key notes
- Bot mode `receiveId`: recommended to set **Bot ID (aibotid)** for strict crypto validation
- App mode decryption uses **CorpID** (`corpId`)

## Webhook setup (WeCom Admin)
### Bot mode
- URL: `https://your-domain/wecom`
- Token: custom string
- EncodingAESKey: generated in admin
- Bot ID (aibotid): map to `receiveId`

### App mode
- URL: `https://your-domain/wecom`
- Token / EncodingAESKey: map to `callbackToken` / `callbackAesKey`
- CorpID / AgentID / Secret: map to `corpId` / `agentId` / `corpSecret`

> HTTPS is required. Restart OpenClaw gateway after enabling the plugin.

## Modes
- `mode: "bot"`: Bot API only
- `mode: "app"`: App only
- `mode: "both"`: both modes (default)

## Media handling
- App mode: downloads inbound media to local temp dir (`media.tempDir`)
- Bot mode media bridge: if reply payload includes `mediaUrl + mediaType`,
  and App credentials are present, media will be uploaded and sent

## Troubleshooting
- Callback verification failed: check Token / AESKey / URL
- No reply: ensure plugin enabled and gateway restarted
- Media too large: adjust `media.maxBytes` or send smaller files
- invalid access_token: verify `corpId/corpSecret/agentId`

## Docs
- Dev doc: `docs/TECHNICAL.md`
- Install: `docs/INSTALL.md`
- Examples: `docs/wecom.config.example.json` / `docs/wecom.config.full.example.json`
