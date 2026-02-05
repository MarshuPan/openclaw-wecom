# OpenClaw WeCom Plugin (Dual Mode)

English | [中文](README.zh.md)

OpenClaw WeCom plugin supporting **Bot API mode** and **Internal App mode** with multi-account, media, and group chat.

## Features
- Dual mode: Bot API (JSON callback + stream) / App (XML callback + ACK + proactive send)
- Multi-account: `channels.wecom.accounts`
- Message types: text / image / voice / video / file (send & receive)
- Commands (App mode): `/help`, `/status`, `/clear`, `/sendfile`
- Stability: signature verification, AES decrypt, token cache, rate limit & retries
- Group chat: uses `appchat/send` when `chatId` is present
- Advanced: folder zip sending, send queue, operation logs, media auto recognition

## Installation

### npm (Recommended)
```bash
openclaw plugins install @marshulll/openclaw-wecom
openclaw plugins enable openclaw-wecom
openclaw gateway restart
```
> The npm package **bundles dependencies** (no extra `npm install` on the server).

### Local Path
```bash
openclaw plugins install --link /path/to/openclaw-wecom
openclaw plugins enable openclaw-wecom
openclaw gateway restart
```
> For local path installs, run `npm install` in the project directory first.

## Configuration

Write config to `~/.openclaw/openclaw.json`

- Minimal example: `docs/wecom.config.example.json`
- Full example: `docs/wecom.config.full.example.jsonc` (with comments)

> Recommendation: use **separate webhookPath** for Bot and App (e.g. `/wecom/bot` and `/wecom/app`) for clearer debugging.

### Config Example (Dual Mode)
```json5
{
  "channels": {
    "wecom": {
      "enabled": true,
      "mode": "both",
      "defaultAccount": "bot",
      "accounts": {
        "bot": {
          "mode": "bot",
          "webhookPath": "/wecom/bot",
          "token": "BOT_TOKEN",
          "encodingAESKey": "BOT_AES",
          "receiveId": "BOT_ID"
        },
        "app": {
          "mode": "app",
          "webhookPath": "/wecom/app",
          "corpId": "CORP_ID",
          "corpSecret": "CORP_SECRET",
          "agentId": 1000001,
          "callbackToken": "CALLBACK_TOKEN",
          "callbackAesKey": "CALLBACK_AES"
        }
      }
    }
  }
}
```

### Key Fields
| Field | Description |
|-------|-------------|
| `receiveId` | Bot mode: **Bot ID (aibotid)** for callback crypto validation |
| `corpId` | App mode: Corp ID for callback decryption and API calls |
| `agentId` | App mode: Agent ID (integer) |

### Mode Options
- `mode: "bot"`: Bot API only
- `mode: "app"`: App only
- `mode: "both"`: both modes (default)

## Webhook Setup (WeCom Admin)

Both modes require **public HTTPS**. Restart OpenClaw gateway after configuration.

### Bot Mode
- URL: `https://your-domain/wecom/bot`
- Token / EncodingAESKey: generated in admin, map to `token` / `encodingAESKey`
- Bot ID (aibotid): map to `receiveId`

### App Mode
- URL: `https://your-domain/wecom/app`
- Token / EncodingAESKey: generated in admin, map to `callbackToken` / `callbackAesKey`
- CorpID / AgentID / Secret: map to `corpId` / `agentId` / `corpSecret`

## Media Handling

### Inbound Media
- **App mode**: downloads media to local temp dir (configurable via `media.tempDir`)
- **Bot mode**: if webhook provides media URL, decrypts with `encodingAESKey` and saves locally

### Outbound Media
- **Requires App credentials** (`corpId/corpSecret/agentId`) to send media
- Bot mode media bridge: when reply payload contains `mediaUrl + mediaType`, auto uploads and sends

### Image Recognition
Two recognition methods supported:

1. **Model vision input (default)**: let the model see the image directly
   - Requires model's `input` to include `"image"` in `~/.openclaw/openclaw.json`

2. **Plugin built-in vision (optional)**: enable `channels.wecom.media.vision.enabled=true`
   - Plugin generates recognition result first, falls back to model vision on failure

### Video Recognition
- Requires **ffmpeg** installation
- Enable: `media.auto.video.enabled=true`
- Modes: `light` (default, extract few frames) / `full` (extract frames at intervals)

```bash
# Ubuntu/Debian
sudo apt-get update && sudo apt-get install -y ffmpeg

# macOS
brew install ffmpeg
```

## File Sending

### /sendfile Command (App Mode)

Send server files, supports multiple absolute paths:
```
/sendfile /tmp/openclaw-wecom /home/user/report.pdf
```
- Directories: auto-zipped before sending

### Natural Language File Sending (App Mode)

Send files using natural language:
```
send me that report
send me the pdf files on desktop
send me the screenshots in downloads
```

**Smart Search Features**:

- **Fuzzy matching**: Files are matched if their name contains keywords (e.g., "report" matches `monthly-report.pdf`)
- **Recursive search**: Automatically searches subdirectories (up to 3 levels deep)
- **Multi-directory search**: Searches Desktop, Downloads, Documents, and temp directories simultaneously
- **Smart sorting**: Results sorted by relevance, most relevant files first

**Search Directory Keywords**:

| Keyword | Search Directory |
|---------|------------------|
| `桌面` (desktop) | `~/Desktop` |
| `下载`, `download` | `~/Downloads` |
| `文档`, `document` | `~/Documents` |
| `临时`, `tmp` | Configured temp directory |
| `工作`, `work` | Configured workspace |

**Custom Search Directories**: Add `media.searchPaths` in config:
```json
{
  "channels": {
    "wecom": {
      "accounts": {
        "app": {
          "media": {
            "searchPaths": ["~/Projects", "/data/files"]
          }
        }
      }
    }
  }
}
```

### Agent File Send/Receive (App Mode)

Let Agent send files via `message` tool (e.g., "send me the file on desktop").

**Prerequisites**:

1. App mode credentials must be configured
2. Tool permissions enabled (see "OpenClaw Tool Permissions" below)

**Supported Media Types**:

| Type | Extensions | Size Limit |
|------|------------|------------|
| Image | `.jpg` `.jpeg` `.png` `.gif` `.bmp` `.webp` | 10MB |
| Voice | `.amr` `.mp3` `.wav` `.m4a` `.ogg` | 2MB |
| Video | `.mp4` `.mov` `.avi` `.mkv` `.webm` | 10MB |
| File | All other extensions | 20MB |

## Proactive Push (App Mode)

Endpoint path: `{webhookPath}/push` (e.g. `/wecom/app/push`)

```bash
curl -X POST "https://your-domain/wecom/app/push" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer PUSH_TOKEN" \
  -d '{"toUser":"WenShuJun","text":"Hello"}'
```

| Parameter | Description |
|-----------|-------------|
| `toUser` | Target user ID |
| `chatId` | Target group ID (mutually exclusive with toUser) |
| `text` | Text content |
| `mediaUrl` | Media URL (can be sent with text) |

## Unified Outbound (CLI)

Send messages via OpenClaw CLI:
```bash
openclaw message send --channel wecom --target WenShuJun "Hello"
openclaw message send --channel wecom --target chat:CHAT_ID "Group test"
```

## OpenClaw Tool Permissions

To allow Agent to execute local commands (view files, run scripts, etc.), enable elevated permissions.

Add to `~/.openclaw/openclaw.json`:

```json
{
  "tools": {
    "elevated": {
      "enabled": true,
      "allowFrom": {
        "wecom": ["*"]
      }
    }
  }
}
```

> **Note**: `"*"` allows all users to use elevated features. For production, restrict to specific user IDs: `["user_id_1", "user_id_2"]`

Restart Gateway after configuration:
```bash
openclaw gateway restart
```

Verify configuration (send in WeCom):

- "Show me what files are in the current directory"
- "Run ls -la command"

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Callback verification failed | Check Token / AESKey / URL consistency |
| No reply | Ensure plugin enabled and gateway restarted |
| Media too large | Adjust `media.maxBytes` or send smaller files |
| invalid access_token | Verify `corpId/corpSecret/agentId` |
| Agent cannot execute commands | Check `tools` config and allowlist |
| `errcode=60020` | WeCom IP whitelist issue, add server egress IP (`curl -s https://ipinfo.io/ip`) |

## Documentation
- Dev docs: `docs/TECHNICAL.md`
- Config examples: `docs/wecom.config.example.json` / `docs/wecom.config.full.example.jsonc`
- Testing checklist: `docs/TESTING.md`
