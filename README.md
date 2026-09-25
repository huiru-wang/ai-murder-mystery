# AI Murder Mystery

AI Murder Mystery 是一个真人与独立 AI 玩家共同参与的在线剧本推理游戏。当前 Web 形态是单人即可开局：真人创建房间、选择角色后，其余席位由 AI Player 接管。每个 AI 都有自己的角色身份、私密信息、目标、线索与独立 Agent Session，会像真实玩家一样讨论、隐瞒、质询、搜证、投票并在合适的时候结束自己的本轮参与。

当前内置六人剧本《第七码头》，完整流程包括：自我介绍、自由讨论、搜证、再次讨论、再次搜证、最终讨论、投票和真相复盘。

## 核心设计

这个项目不是“一个 Chatbot 扮演所有角色”，而是由多个职责清晰的运行时组件共同驱动：

- **AI Player**：每个 AI 玩家是独立 Agent，按 `(roomId, playerId)` 隔离 Session。
- **Information Isolation**：AI 只能看到公共信息、自己的角色私密信息和自己获得的私有线索，不会看到其他角色秘密或最终真相。
- **GameDirector**：确定性规则层，负责当前轮次、行动顺序、完成条件和阶段推进。
- **Scheduler**：确定性控场器，负责判断何时应该再次激活哪个 AI，但不决定 AI 说什么。
- **Context Builder**：每次 AI 激活时，根据当前房间状态构建动态上下文。
- **Tool-driven Action**：AI 对游戏世界的所有有效动作都必须通过 Tool 完成，普通模型文本不会直接进入群聊。
- **Persistent Session**：同一房间内每个 AI 拥有持续会话；房间之间完全隔离。

详细设计见 [docs](./docs/README.md)。

## 仓库结构

```text
apps/
  murder-mystery-api/     Hono API、游戏规则、SQLite、Scheduler、AI Player Runtime
  murder-mystery-web/     React/Vite Web 客户端
packages/
  murder-mystery-shared/  前后端共享 API 类型

docs/                     产品与架构文档
```

## 本地开发

```bash
git clone git@github.com:huiru-wang/ai-murder-mystery.git
cd ai-murder-mystery
pnpm install
cp apps/murder-mystery-api/.env.example apps/murder-mystery-api/.env
pnpm start:local
```

默认地址：

- Web：`http://127.0.0.1:5173`
- API：`http://127.0.0.1:3200`

`.env.example` 默认使用 live 模式。填写对应 Provider 的 API Key 后使用真实模型；需要无密钥验证完整流程时，可将：

```env
AI_MURDER_MYSTERY_AI_MODE=mock
```

## 常用命令

```bash
pnpm start:local
pnpm typecheck
pnpm test
pnpm build
pnpm deploy
```

## 文档

- [产品逻辑](./docs/product/product.md)
- [整体架构](./docs/architecture/overview.md)
- [AI Player 架构](./docs/architecture/ai-player.md)
- [Game Runtime 与 Scheduler](./docs/architecture/game-runtime.md)
- [开发、配置与测试](./docs/engineering/development.md)
- [部署](./docs/engineering/deployment.md)
