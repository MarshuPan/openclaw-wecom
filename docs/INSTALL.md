# OpenClaw WeCom 插件安装与配置

## 安装

### 方式一：npm 安装
```bash
openclaw plugins install @marshulll/openclaw-wecom
openclaw plugins enable openclaw-wecom
openclaw gateway restart
```
> npm 包已内置依赖（无需在服务器额外执行 `npm install`）。

### 方式二：本地路径加载
```bash
openclaw plugins install --link /path/to/openclaw-wecom
openclaw plugins enable openclaw-wecom
openclaw gateway restart
```
> 本地路径加载前请先在项目目录执行 `npm install`。

## 配置

将配置写入 OpenClaw 配置文件（通常在 `~/.openclaw/openclaw.json`）：

- 配置模板（最小）：`docs/wecom.config.example.json`
- 配置模板（全量）：`docs/wecom.config.full.example.json`

> 推荐仅使用 `~/.openclaw/openclaw.json` 作为主配置来源；`env.vars` 与系统环境变量仅作为兜底。

最小示例（单账户）：
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

推荐示例（Bot/App 独立路径）：
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

## 环境变量示例（可选）

如果你更希望用环境变量，也可以写在 `~/.openclaw/openclaw.json` 的 `env.vars` 中（优先级低于 `channels.wecom` 配置）：

```json5
{
  "env": {
    "vars": {
      "WECOM_TOKEN": "BOT_TOKEN",
      "WECOM_ENCODING_AES_KEY": "BOT_AES",
      "WECOM_RECEIVE_ID": "BOT_ID",
      "WECOM_CORP_ID": "CORP_ID",
      "WECOM_CORP_SECRET": "CORP_SECRET",
      "WECOM_AGENT_ID": "1000001",
      "WECOM_CALLBACK_TOKEN": "CALLBACK_TOKEN",
      "WECOM_CALLBACK_AES_KEY": "CALLBACK_AES",
      "WECOM_WEBHOOK_PATH": "/wecom"
    }
  }
}
```

多账户示例（ACCOUNT 为大写）：

```json5
{
  "env": {
    "vars": {
      "WECOM_SALES_TOKEN": "BOT_TOKEN",
      "WECOM_SALES_ENCODING_AES_KEY": "BOT_AES",
      "WECOM_SALES_RECEIVE_ID": "BOT_ID",
      "WECOM_SALES_CORP_ID": "CORP_ID",
      "WECOM_SALES_CORP_SECRET": "CORP_SECRET",
      "WECOM_SALES_AGENT_ID": "1000002",
      "WECOM_SALES_CALLBACK_TOKEN": "CALLBACK_TOKEN",
      "WECOM_SALES_CALLBACK_AES_KEY": "CALLBACK_AES",
      "WECOM_SALES_WEBHOOK_PATH": "/wecom/sales"
    }
  }
}
```

### 字段说明
- Bot 模式 `receiveId`：建议填写 **Bot ID（aibotid）**，用于回调加解密校验；不填也可通过，但会降低校验严格性。
- App 模式回调解密使用 **CorpID**（即 `corpId`），与 Bot 模式的 `receiveId` 无关。

## 高级能力（可选）
### /sendfile（文件与文件夹）
- 仅 **App 模式** 支持 `/sendfile`
- `/sendfile` 仅支持 **服务器绝对路径**
- 目录会自动打包为 zip 再发送
- 自然语言也可触发：`把这个文件发给我 image-xxx.jpg`（默认仅在 `media.tempDir` 内匹配）
  - 搜索范围关键词：`桌面` → `~/Desktop`，`下载` → `~/Downloads`，`临时` → `media.tempDir`
  - 如匹配多个文件，会返回列表让你确认（回复“全部”或序号；回复“更多”翻页）

示例：
```
/sendfile /tmp/openclaw-wecom /home/shu/Desktop/report.pdf
```

### 多媒体自动识别
- **语音收发不需要 API**；只有开启“语音自动转写”才需要 OpenAI 兼容接口
- **视频识别需要 ffmpeg**（服务器安装后将 `media.auto.video.enabled=true`）
- **视频识别 light/full 模式**：`media.auto.video.mode`（默认 `light`）
- 视频识别已在 App 模式验证；Bot 模式未验证/可能不支持
- 文本文件可自动预览（小文件直接读入）

建议安装 ffmpeg（Ubuntu）：
```bash
sudo apt-get update && sudo apt-get install -y ffmpeg
```

### 发送队列与操作日志
- `sendQueue.intervalMs`：/sendfile 多文件发送间隔
- `operations.logPath`：JSONL 日志，记录发送文件与主动推送

## Webhook 验证
- Bot 模式与 App 模式都要求公网 HTTPS。
- 在企业微信后台配置回调 URL。
- 建议 Bot 与 App 使用不同 `webhookPath`，便于排障与避免回调混淆。

## 主动推送（App 模式）
主动推送接口路径：`{webhookPath}/push`（例如 `/wecom/app/push`）。

- 方法：`POST`
- 鉴权：`pushToken`（可选，但建议开启）
  - `Authorization: Bearer <token>`、`x-openclaw-token`、`token` 参数或 body `token`
- 目标：`toUser`（单人）或 `chatId`（群聊），二选一

最小示例（文本）：
```bash
curl -X POST "https://你的域名/wecom/app/push" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer PUSH_TOKEN" \
  -d '{"toUser":"WenShuJun","text":"你好"}'
```

媒体发送（file/image/voice/video）：使用 `mediaUrl` 或 `mediaBase64`，可与 `text` 同时发送。

## 常见问题
- 回调验证失败：检查 Token / AESKey / URL 是否一致
- 没有回复：检查 OpenClaw 是否已启用插件并重启 gateway
- 插件加载失败（缺依赖）：升级到最新版本并用 npm 安装
