# OpenClaw 企业微信插件（双模式）

中文 | [English](README.en.md)

OpenClaw WeCom 插件，支持 **智能机器人 API 模式** 与 **自建应用模式**（双模式），并支持多账户、媒体消息与群聊。

## 功能概览
- 双模式：Bot API（JSON 回调 + stream）/ App（XML 回调 + ACK + 主动发送）
- 多账户：`channels.wecom.accounts`
- 消息类型：文本 / 图片 / 语音 / 视频 / 文件（收发均支持）
- 机器人命令（App 模式）：`/help`、`/status`、`/clear`、`/sendfile`
- 稳定性：签名校验、AES 解密、token 缓存、限流与重试
- 群聊：自动识别 `chatId` 并使用 `appchat/send`
- 进阶：文件夹打包发送、发送队列、操作日志、多媒体自动识别

## 安装

### npm 安装（推荐）
```bash
openclaw plugins install @marshulll/openclaw-wecom
openclaw plugins enable openclaw-wecom
openclaw gateway restart
```
> npm 安装包已**内置依赖**（无需再在服务器执行 `npm install`）。

### 本地路径加载
```bash
openclaw plugins install --link /path/to/openclaw-wecom
openclaw plugins enable openclaw-wecom
openclaw gateway restart
```
> 本地路径加载需要先在项目目录执行 `npm install`。

## 配置

主配置写入：`~/.openclaw/openclaw.json`

- 最小示例：`docs/wecom.config.example.json`
- 全量示例：`docs/wecom.config.full.example.jsonc`（带注释）

> 建议 Bot 与 App 使用**不同的 webhookPath**（如 `/wecom/bot` 与 `/wecom/app`），便于排障并避免回调混淆。

### 配置示例（双模式）
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

### 关键字段说明
| 字段 | 说明 |
|------|------|
| `receiveId` | Bot 模式：填写 **Bot ID（aibotid）**，用于回调加解密校验 |
| `corpId` | App 模式：企业 ID，用于回调解密和 API 调用 |
| `agentId` | App 模式：应用 ID（整数） |

### 模式说明
- `mode: "bot"`：只启用智能机器人 API 模式
- `mode: "app"`：只启用自建应用模式
- `mode: "both"`：同时启用两种模式（默认）

## 回调配置（企业微信后台）

两种模式都要求**公网 HTTPS**，配置完成后请重启 OpenClaw gateway。

### Bot 模式
- URL：`https://你的域名/wecom/bot`
- Token / EncodingAESKey：后台生成，对应 `token` / `encodingAESKey`
- Bot ID（aibotid）：填写到 `receiveId`

### App 模式
- URL：`https://你的域名/wecom/app`
- Token / EncodingAESKey：后台生成，对应 `callbackToken` / `callbackAesKey`
- CorpID / AgentID / Secret：分别对应 `corpId` / `agentId` / `corpSecret`

## 媒体处理

### 入站媒体
- **App 模式**：收到媒体会下载到本地临时目录（可配置 `media.tempDir`）
- **Bot 模式**：图片/文件若回调提供 URL，会用 `encodingAESKey` 解密并落盘

### 出站媒体
- **必须配置 App 凭据**（`corpId/corpSecret/agentId`）才能发送媒体
- Bot 模式媒体桥接：当 reply payload 含 `mediaUrl + mediaType` 时，会自动上传并发送

### 图片识别
插件支持两种识图方式：

1. **模型视觉输入（默认）**：让模型直接看图
   - 需在 `~/.openclaw/openclaw.json` 把模型的 `input` 包含 `"image"`

2. **插件内置 vision（可选）**：开启 `channels.wecom.media.vision.enabled=true`
   - 插件会先用 vision 生成识别结果，失败则回退到模型视觉输入

### 视频识别
- 需要安装 **ffmpeg**
- 开启：`media.auto.video.enabled=true`
- 模式：`light`（默认，抽取少量帧）/ `full`（按间隔抽帧）

```bash
# Ubuntu/Debian
sudo apt-get update && sudo apt-get install -y ffmpeg

# macOS
brew install ffmpeg
```

## 文件发送

### /sendfile 命令（App 模式）
发送服务器文件，支持多个绝对路径：
```
/sendfile /tmp/openclaw-wecom /home/user/report.pdf
```
- 支持目录：自动打包为 zip 后发送

### 自然语言文件发送（App 模式）

支持用自然语言描述要发送的文件：
```
把那个报告发给我
把桌面的 pdf 文件发给我
发我下载目录里的截图
```

**智能搜索特性**：

- **模糊匹配**：文件名包含关键词即可匹配（如"报告"可匹配 `月度报告.pdf`）
- **递归搜索**：自动搜索子目录（最深3层）
- **多目录搜索**：同时搜索桌面、下载、文档、临时目录
- **智能排序**：按匹配度排序，最相关的文件排在前面

**搜索目录关键词**：

| 关键词 | 搜索目录 |
|--------|----------|
| `桌面` | `~/Desktop` |
| `下载`、`download` | `~/Downloads` |
| `文档`、`document` | `~/Documents` |
| `临时`、`tmp` | 配置的临时目录 |
| `工作`、`work` | 配置的工作目录 |

**自定义搜索目录**：在配置中添加 `media.searchPaths`：
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

### Agent 文件收发（App 模式）
让 Agent 通过 `message` 工具主动发送文件（如"把桌面的文件发给我"）。

**前置条件**：
1. 必须配置 App 模式凭据
2. 启用工具权限（参考下方"OpenClaw 工具权限配置"）

**支持的媒体类型**：
| 类型 | 扩展名 | 大小限制 |
|------|--------|----------|
| 图片 | `.jpg` `.jpeg` `.png` `.gif` `.bmp` `.webp` | 10MB |
| 语音 | `.amr` `.mp3` `.wav` `.m4a` `.ogg` | 2MB |
| 视频 | `.mp4` `.mov` `.avi` `.mkv` `.webm` | 10MB |
| 文件 | 其他所有扩展名 | 20MB |

## 主动推送（App 模式）

接口路径：`{webhookPath}/push`（例如 `/wecom/app/push`）

```bash
curl -X POST "https://你的域名/wecom/app/push" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer PUSH_TOKEN" \
  -d '{"toUser":"WenShuJun","text":"你好"}'
```

| 参数 | 说明 |
|------|------|
| `toUser` | 目标用户 ID |
| `chatId` | 目标群聊 ID（与 toUser 二选一） |
| `text` | 文本内容 |
| `mediaUrl` | 媒体 URL（可与 text 同时发送） |

## 统一出站（CLI）

通过 OpenClaw CLI 主动发送消息：
```bash
openclaw message send --channel wecom --target WenShuJun "你好"
openclaw message send --channel wecom --target chat:CHAT_ID "群消息测试"
```

## OpenClaw 工具权限配置

如果希望 Agent 能够执行本地命令（如查看文件、运行脚本等），需要启用 elevated 权限。

在 `~/.openclaw/openclaw.json` 中添加：

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

> **说明**：`"*"` 表示允许所有用户使用提权功能。生产环境可限制为特定用户 ID：`["user_id_1", "user_id_2"]`

配置完成后重启 Gateway：
```bash
openclaw gateway restart
```

验证配置（在企业微信中发送）：

- "帮我看下当前目录有什么文件"
- "运行 ls -la 命令"

## 常见问题

| 问题 | 解决方案 |
|------|----------|
| 回调验证失败 | 检查 Token / AESKey / URL 是否一致 |
| 没有回复 | 确认已启用插件并重启 gateway |
| 媒体过大 | 调整 `media.maxBytes` 或发送更小文件 |
| invalid access_token | 检查 `corpId/corpSecret/agentId` |
| Agent 无法执行命令 | 检查 `tools` 配置和白名单 |
| `errcode=60020` | 企业微信 IP 白名单问题，需添加服务器出口 IP（`curl -s https://ipinfo.io/ip`） |

## 资料入口
- 开发文档：`docs/TECHNICAL.md`
- 配置示例：`docs/wecom.config.example.json` / `docs/wecom.config.full.example.jsonc`
- 测试清单：`docs/TESTING.md`
