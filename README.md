# AI Murder Mystery

一款由 AI 玩家共同参与的在线剧本推理游戏。你可以创建房间、选择角色、阅读专属剧本，与其他玩家围绕线索展开讨论、提问、搜证和投票，最终揭开完整真相。

## 体验内容

内置剧本《第七码头》支持 6 人推理局。真人玩家确定角色后，剩余席位由 AI 补齐。AI 会依据公开信息和自己掌握的私密内容行动，不会预先知道其他角色的秘密或最终真相。

游戏依次推进角色介绍、讨论、搜证、投票与真相复盘。私密剧本、未公开线索和投票结果只会在应当揭示的阶段展示。

## 本地开发

```bash
git clone git@github.com:huiru-wang/ai-murder-mystery.git
cd ai-murder-mystery
pnpm install
cp apps/murder-mystery-api/.env.example apps/murder-mystery-api/.env
pnpm start:local
```

本地 Web 为 `http://127.0.0.1:5173`，API 为 `http://127.0.0.1:3200`。启动脚本会读取 API 目录下的 `.env`，并同时启动 API 与 Web；按 Ctrl+C 会一并停止它们。

`.env.example` 默认是 live 模式。填写 `DEEPSEEK_API_KEY` 后使用真实 AI；想无密钥体验完整流程，可将 `.env` 中的 `AI_MURDER_MYSTERY_AI_MODE` 改为 `mock`：

```bash
pnpm start:local
```

## 服务器部署

服务器需安装 Node.js、pnpm、Nginx、curl 和 flock，并提供 sudo 权限。确认 SSL 证书覆盖 `ai-murder-mystery.robinverse.me`，且文件位于：

```text
/etc/nginx/ssl/robinverse.me.pem
/etc/nginx/ssl/robinverse.me.key
```

在服务器上准备生产配置后部署：

```bash
cd /path/to/ai-murder-mystery
pnpm install
cp apps/murder-mystery-api/.env.example apps/murder-mystery-api/.env.production
# 编辑 .env.production，填写真实模型配置和 API Key
pnpm deploy
```

部署脚本会构建项目，发布 Web 到 `/var/www/ai-murder-mystery`，用 `nohup` 和 PID 文件启动本机 `3200` 端口的 API，并写入专用 Nginx 配置。它不使用 systemd；API 日志位于 `/var/lib/ai-murder-mystery/logs/api.log`。

注意：脚本会替换 `/etc/nginx/nginx.conf`，因此服务器应只承载本项目。主机重启后需再次执行 `pnpm deploy`。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
```

详细的架构、配置、测试和部署说明见 [docs](./docs/README.md)。
