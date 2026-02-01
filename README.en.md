# OpenClaw WeCom Plugin (Dual Mode)

English | [中文](README.zh.md)

OpenClaw WeCom plugin supporting **Bot API mode** and **Internal App mode** with multi-account, media, and group chat.

> `docs/TECHNICAL.md` is the source of truth. Read it before development.

## Features
- Dual mode: Bot API (JSON callback + stream) / App (XML callback + ACK + proactive send)
- Multi-account: `channels.wecom.accounts`
- Message types: text / image / voice / video / file (send & receive)
- Commands (App mode): `/help`, `/status`, `/clear`, `/sendfile`
- Stability: signature verification, AES decrypt, token cache, rate limit & retries
- Group chat: uses `appchat/send` when `chatId` is present
- Advanced: folder zip sending, send queue, operation logs, media auto recognition

## Install
### npm
```bash
openclaw plugins install @marshulll/openclaw-wecom
openclaw plugins enable openclaw-wecom
openclaw gateway restart
```
> The npm package **bundles dependencies** (no extra `npm install` on the server).

### Local path
```bash
openclaw plugins install --link /path/to/openclaw-wecom
openclaw plugins enable openclaw-wecom
openclaw gateway restart
```
> For local path installs, run `npm install` in the project directory first.

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
- Bot inbound media: if webhook provides a media URL, it will be decrypted with `encodingAESKey` and saved locally (no App creds needed)
- Bot mode media bridge: if reply payload includes `mediaUrl + mediaType`,
  and App credentials are present, media will be uploaded and sent
> Bot-only: inbound image/file works via URL decrypt, but outbound media still requires App credentials.
> Video recognition is verified in App mode; Bot mode is not yet verified/likely unsupported. If you still want to try, enable `media.auto.video` and ensure the webhook payload includes a downloadable video URL, otherwise it falls back to a plain “received video” prompt.

## Extra commands (App mode)
- `/sendfile`: send files from server (multiple absolute paths)
  - Directories are zipped automatically
  - Example: `/sendfile /tmp/openclaw-wecom /home/shu/Desktop/report.pdf`
  - Natural language also works: "send me this file image-xxx.jpg" (default match in `media.tempDir`)
  - Search scope keywords: `桌面` → `~/Desktop`, `下载` → `~/Downloads`, `临时` → `media.tempDir`
  - If multiple matches are found, a list will be returned for confirmation; reply "more" to paginate

## Proactive send (App mode)
Push endpoint path: `{webhookPath}/push` (e.g. `/wecom/app/push`).

- Method: `POST`
- Auth: `pushToken` (optional but recommended)
  - Accepts `Authorization: Bearer <token>`, `x-openclaw-token`, query/body `token`
- Target: `toUser` (DM) or `chatId` (group)

Minimal example (text):
```bash
curl -X POST "https://your-domain/wecom/app/push" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer PUSH_TOKEN" \
  -d '{"toUser":"WenShuJun","text":"Hello"}'
```

Media (file/image/voice/video): use `mediaUrl` or `mediaBase64`. You can also send text together.

## Media auto recognition (optional)
- **Voice send/receive does NOT require API**; only auto transcription needs an OpenAI-compatible API
- **Video recognition requires ffmpeg** (install on server, then set `media.auto.video.enabled = true`)
- Video recognition supports **light / full** modes (default: light) via `media.auto.video.mode`
- Small text files can be previewed automatically

## Send queue & operation logs (optional)
- `sendQueue.intervalMs`: delay between /sendfile items to avoid rate limit
- `operations.logPath`: JSONL log for file sending and push actions

## Troubleshooting
- Callback verification failed: check Token / AESKey / URL
- No reply: ensure plugin enabled and gateway restarted
- Media too large: adjust `media.maxBytes` or send smaller files
- invalid access_token: verify `corpId/corpSecret/agentId`
- Plugin failed to load due to missing deps: upgrade to latest and install via npm

## Docs
- Dev doc: `docs/TECHNICAL.md`
- Install: `docs/INSTALL.md`
- Examples: `docs/wecom.config.example.json` / `docs/wecom.config.full.example.json`
- Testing: `docs/TESTING.md`

Recommendation: use **separate webhookPath** for Bot and App (e.g. `/wecom/bot` and `/wecom/app`) for clearer debugging and fewer callback mix-ups.
