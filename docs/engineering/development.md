# 开发、配置与测试

## 安装与启动

```bash
pnpm install
cp apps/murder-mystery-api/.env.example apps/murder-mystery-api/.env
pnpm start:local
```

默认：

- Web：`http://127.0.0.1:5173`
- API：`http://127.0.0.1:3200`

`start:local` 会读取 `apps/murder-mystery-api/.env`，同时启动 API 与 Web；前台 Web 退出时会一并停止 API。

分开启动时可使用：

```bash
pnpm dev:api
pnpm dev:web
```

## AI 模式

### live

调用真实模型：

```env
AI_MURDER_MYSTERY_AI_MODE=live
```

必须同时配置有效的 Provider、Model 和对应 API Key。

### mock

用于本地和自动化测试，不调用外部模型：

```env
AI_MURDER_MYSTERY_AI_MODE=mock
```

Mock Runtime 会按确定性策略完成完整游戏流程。

## 环境变量

当前 API 支持以下配置。`.env.example` 中每一项也带有对应注释。

### 服务与数据

```env
# API 服务监听端口。默认值：3200。
AI_MURDER_MYSTERY_API_PORT=3200

# 游戏主数据库 SQLite 文件路径，用于保存房间、轮次、消息、线索、投票等游戏状态。默认值：data/game.sqlite。
AI_MURDER_MYSTERY_SQLITE_PATH=data/game.sqlite

# Agent 会话数据库 SQLite 文件路径，用于保存 AI 玩家会话和模型上下文。默认值：data/agent.sqlite。
AI_MURDER_MYSTERY_AGENT_DB=data/agent.sqlite

# 可选：启动时扫描并导入其中的 .zip 种子剧本。未配置或目录不存在时，服务以空剧本库启动。
AI_MURDER_MYSTERY_SCRIPT_PACKAGE_DIR=data/scripts
```

### 模型

```env
# AI 运行模式。live=调用真实模型；mock=使用本地 Mock Agent，主要用于测试。默认值：live。
AI_MURDER_MYSTERY_AI_MODE=live

# AI 模型 Provider，必须与 Pi 模型目录中的 provider id 一致，例如 deepseek。默认值：deepseek。
AI_MURDER_MYSTERY_MODEL_PROVIDER=deepseek

# AI 模型名称，必须是当前 Pi 模型目录中存在的 model id，例如 deepseek-v4-flash 或 deepseek-v4-pro。
AI_MURDER_MYSTERY_MODEL_NAME=deepseek-v4-pro

# DeepSeek API Key。仅在 Provider=deepseek 且 AI_MODE=live 时使用；请勿提交真实密钥到 Git。
DEEPSEEK_API_KEY=
```

API 启动前会校验 Provider/Model 是否存在于当前模型目录，配置错误会 fail fast，而不是启动后对每个 active room 重复报错。

### 自由讨论收敛

```env
# 自由讨论持续多少分钟后进入“建议收敛”状态。单位：分钟；默认值：8。
AI_MURDER_MYSTERY_DISCUSSION_PACING_AFTER_MINUTES=8

# 当前自由讨论累计多少条公开交流后进入“建议收敛”状态。统计公开发言、提问、回答和公开线索；默认值：30。
AI_MURDER_MYSTERY_DISCUSSION_PACING_MESSAGE_COUNT=30

# 当前自由讨论累计多少次 AI Agent 激活后进入“建议收敛”状态。默认值：45。
AI_MURDER_MYSTERY_DISCUSSION_PACING_ACTIVATION_COUNT=45
```

三项必须是 `>= 1` 的整数；非法值会在配置读取阶段直接报错。

## SQLite

默认使用两个数据库：

```text
data/game.sqlite
data/agent.sqlite
```

两者都属于运行时数据，不应提交到 Git。

`game.sqlite` 保存游戏事实；`agent.sqlite` 保存 Agent Harness Session。二者职责不同，不应合并为一个 source of truth。

`game.sqlite` 的 `script_versions` 表保存已导入剧本的标准化定义。上传 ZIP 会在临时目录中校验后立即清理，v1 不保存上传原件或其中的 assets；配置的 `data/scripts` 仅用于启动时导入种子包。

## 剧本包开发与导入

剧本格式、校验项、版本约束和 HTTP API 见[剧本包、导入与版本](../platform/script-packages.md)。创作故事并生成包时，使用仓库已有的 [`murder-mystery-script-creator`](../../skills/murder-mystery-script-creator/) Skill。

可用真实导入器在本地校验一个 ZIP：

```bash
pnpm --filter @ai-murder-mystery/api exec tsx ../../skills/murder-mystery-script-creator/scripts/validate-package.ts /absolute/path/to/package.zip
```

通过校验后，可以在首页选择“导入 ZIP”，或向 `POST /api/scripts/import` 提交 `multipart/form-data` 的 `package` 文件字段。成功导入只发布剧本；创建 Room 仍需另行选择剧本并调用创建房间流程。

## 测试与验证

常用验证：

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @ai-murder-mystery/web lint
```

API E2E 使用 Mock Agent，不依赖外部 Provider。

涉及以下行为的修改必须有回归测试：

- Room 隔离
- 角色私密信息隔离
- Agent Session 隔离
- Direct Question
- `pass` / `finish_round`
- Scheduler Trigger
- Nudge
- 搜证独立配额
- Sealed Vote
- Room 删除生命周期
- SQLite migration
- Scheduler pacing 配置
- 剧本 ZIP 导入、版本幂等和 Room 版本钉住
