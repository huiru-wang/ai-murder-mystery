# 部署

## 当前部署模型

生产部署入口：

```bash
pnpm deploy
```

实际执行：

```text
deploy/manual/deploy.sh
```

当前部署方式刻意保持简单：

- Web 构建后发布到 `/var/www/ai-murder-mystery`
- API 监听本机 `127.0.0.1:3200`
- API 使用 `nohup + PID file` 运行
- Nginx 作为 HTTPS 入口和反向代理
- 不使用 systemd

## 生产环境变量

默认生产配置文件：

```text
apps/murder-mystery-api/.env.production
```

可通过：

```text
AI_MURDER_MYSTERY_ENV_FILE
```

指定其他文件。

生产环境至少需要正确配置：

- `AI_MURDER_MYSTERY_AI_MODE=live`
- `AI_MURDER_MYSTERY_MODEL_PROVIDER`
- `AI_MURDER_MYSTERY_MODEL_NAME`
- 对应 Provider API Key
- Scheduler pacing 配置可按需要覆盖默认值
- 可选的 `AI_MURDER_MYSTERY_SCRIPT_PACKAGE_DIR`（仅用于随部署导入种子 ZIP）

## 部署目录

默认：

```text
/var/www/ai-murder-mystery            Web 静态文件
/var/lib/ai-murder-mystery             运行时目录
/var/lib/ai-murder-mystery/game.sqlite 游戏数据库
/var/lib/ai-murder-mystery/agent.sqlite Agent 会话数据库
/var/lib/ai-murder-mystery/logs/api.log API 日志
/var/lib/ai-murder-mystery/run/api.pid PID 文件
```

若配置种子剧本目录，应将其放在持久化运行目录中，例如：

```text
/var/lib/ai-murder-mystery/scripts/*.zip
```

并令 `AI_MURDER_MYSTERY_SCRIPT_PACKAGE_DIR=/var/lib/ai-murder-mystery/scripts`。启动时会校验并幂等导入这些包；它们最终同样以标准化定义保存在 `game.sqlite`。浏览器上传的 ZIP 不会被写入该目录，也不会保存原 ZIP 或 assets。

## Nginx 与证书

部署脚本使用：

```text
deploy/manual/nginx/nginx.conf
```

并默认写入：

```text
/etc/nginx/nginx.conf
```

证书默认位于：

```text
/etc/nginx/ssl/robinverse.me.pem
/etc/nginx/ssl/robinverse.me.key
```

证书必须覆盖：

```text
ai-murder-mystery.robinverse.me
```

部署前会执行 `nginx -t`，通过后 reload；如果 Nginx 尚未运行，则直接启动。

## 部署流程

`deploy/manual/deploy.sh` 会：

1. 校验 Node.js、pnpm、Nginx、curl、flock。
2. 校验生产 `.env` 是否存在。
3. 通过 flock 防止并发部署。
4. `pnpm install --frozen-lockfile`。
5. `pnpm build`。
6. 原子替换 Web 静态目录。
7. 停止旧 API PID，使用生产 env 启动新 API。
8. 轮询 `/health` 等待 API ready。
9. 安装并验证 Nginx 配置。
10. 调用 `/api/scripts` 做最终验证。

## 当前限制

API 不使用 systemd，因此主机重启后不会自动恢复进程。当前策略是主机重启后重新执行：

```bash
pnpm deploy
```

如果未来引入 systemd、pm2 或容器编排，需要同步更新本文件和 README，不能让文档继续描述旧运行方式。

当前 v1 也没有剧本删除、取消发布或原包下载接口。若运营需要这些能力，应先为数据库版本、历史 Room 引用和审计策略定义新的平台能力，再扩展 API；不要直接删除 SQLite 行。
