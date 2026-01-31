# OpenClaw WeCom 插件安装与配置

## 安装

### 方式一：npm 安装
```bash
openclaw plugins install @marshulll/wecom-dual
openclaw plugins enable wecom
openclaw gateway restart
```

### 方式二：本地路径加载
```bash
openclaw plugins install --link /path/to/openclaw-wecom
openclaw plugins enable wecom
openclaw gateway restart
```

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

## Webhook 验证
- Bot 模式与 App 模式都要求公网 HTTPS。
- 在企业微信后台配置回调 URL。

## 常见问题
- 回调验证失败：检查 Token / AESKey / URL 是否一致
- 没有回复：检查 OpenClaw 是否已启用插件并重启 gateway
