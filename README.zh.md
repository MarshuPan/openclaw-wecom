# OpenClaw 企业微信插件（双模式）

中文 | [English](README.en.md)

OpenClaw WeCom 插件，支持 **智能机器人 API 模式** 与 **自建应用模式**（双模式），并支持多账户、媒体消息与群聊。

> 以 `docs/TECHNICAL.md` 为准；开发前请先阅读。

## 功能概览
- 双模式：Bot API（JSON 回调 + stream）/ App（XML 回调 + ACK + 主动发送）
- 多账户：`channels.wecom.accounts`
- 消息类型：文本 / 图片 / 语音 / 视频 / 文件（收发均支持）
- 机器人命令（App 模式）：`/help`、`/status`、`/clear`、`/sendfile`
- 稳定性：签名校验、AES 解密、token 缓存、限流与重试
- 群聊：自动识别 `chatId` 并使用 `appchat/send`
- 进阶：文件夹打包发送、发送队列、操作日志、多媒体自动识别

## 安装
### npm 安装
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
推荐仅使用主配置；环境变量仅作为兜底。

最小示例：`docs/wecom.config.example.json`  
全量示例：`docs/wecom.config.full.example.json`  
安装与配置说明：`docs/INSTALL.md`

建议：Bot 与 App 使用**不同的 webhookPath**（如 `/wecom/bot` 与 `/wecom/app`），便于排障并避免回调混淆。

### 最小配置示例
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

### 关键字段说明
- Bot 模式 `receiveId`：建议填写 **Bot ID（aibotid）**，用于回调加解密校验
- App 模式回调解密使用 **CorpID**（`corpId`）

## 回调配置（企业微信后台）
### Bot 模式
- URL：`https://你的域名/wecom`
- Token：自定义
- EncodingAESKey：后台生成
- Bot ID（aibotid）：填写到 `receiveId`

### App 模式
- URL：`https://你的域名/wecom`
- Token / EncodingAESKey：后台生成，对应 `callbackToken` / `callbackAesKey`
- CorpID / AgentID / Secret：分别对应 `corpId` / `agentId` / `corpSecret`

> 两种模式都要求公网 HTTPS；配置完成后请重启 OpenClaw gateway。

## 模式说明
- `mode: "bot"`：只启用智能机器人 API 模式
- `mode: "app"`：只启用自建应用模式
- `mode: "both"`：同时启用两种模式（默认）

## 媒体处理说明
- App 模式：收到媒体会下载到本地临时目录（可配置 `media.tempDir`）
- Bot 模式入站媒体：图片/文件若回调提供 URL，会用 `encodingAESKey` 解密并落盘（无需 App 凭据）
- Bot 模式媒体桥接：当 reply payload 含 `mediaUrl + mediaType` 时，
  若已配置 App 凭据，会自动上传并发送媒体
> 仅配置 Bot 时：可收图片/文件（URL 解密），但**出站媒体仍需 App 凭据**。
> 视频识别已在自建应用（App）模式验证可用；Bot 模式目前未验证/可能不支持，如需尝试需开启 `media.auto.video` 且回调必须提供可下载的视频 URL，否则只能给出“收到视频”的文本提示。

## 命令补充（App 模式）
- `/sendfile`：发送服务器文件（支持多个绝对路径）
  - 支持目录：自动打包为 zip 后发送
  - 示例：`/sendfile /tmp/openclaw-wecom /home/shu/Desktop/report.pdf`
  - 也支持自然语言：`把这个文件发给我 image-xxx.jpg`（默认仅在 `media.tempDir` 内匹配）
  - 搜索范围关键词：`桌面` → `~/Desktop`，`下载` → `~/Downloads`，`临时` → `media.tempDir`
  - 多文件会先返回列表，回复“全部”或序号再发送；回复“更多”可翻页

## 主动消息（App 模式）
主动推送接口路径为：`{webhookPath}/push`（例如 `/wecom/app/push`）。

- 方法：`POST`
- 鉴权：`pushToken`（可选，但建议开启）
  - 可放在 `Authorization: Bearer <token>`、`x-openclaw-token`、`token` 参数或 body 的 `token` 字段
- 目标：`toUser`（单人）或 `chatId`（群聊），二选一

最小示例（文本）：
```bash
curl -X POST "https://你的域名/wecom/app/push" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer PUSH_TOKEN" \
  -d '{"toUser":"WenShuJun","text":"你好"}'
```

发送媒体（file/image/voice/video）：支持 `mediaUrl` 或 `mediaBase64`，可与 `text` 同时发送。

## 多媒体自动识别（可选）
- **语音收发不需要 API**，只有开启“语音自动转写”才需要 OpenAI 兼容接口
- **视频识别需要 ffmpeg**（服务器已安装后，将 `media.auto.video.enabled` 设为 `true`）
- 视频识别支持 **light / full** 两种模式（默认 light），可通过 `media.auto.video.mode` 切换
- 文本文件可自动预览（小文件直接读入）

## 发送队列与操作日志（可选）
- `sendQueue.intervalMs`：/sendfile 多文件发送间隔（防止限流）
- `operations.logPath`：记录发送文件/主动推送（JSONL）

## 常见问题
- 回调验证失败：检查 Token / AESKey / URL 是否一致
- 没有回复：确认已启用插件并重启 gateway
- 媒体过大：调整 `media.maxBytes` 或发送更小文件
- invalid access_token：检查 `corpId/corpSecret/agentId`
- 依赖缺失导致插件未加载：请升级到最新版本并通过 npm 安装

## 资料入口
- 开发文档：`docs/TECHNICAL.md`
- 安装配置：`docs/INSTALL.md`
- 配置示例：`docs/wecom.config.example.json` / `docs/wecom.config.full.example.json`
- 测试清单：`docs/TESTING.md`
