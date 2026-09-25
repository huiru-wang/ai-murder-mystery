# AI Murder Mystery Agent Guide

## 项目边界

- 本仓库是独立的 AI Murder Mystery 项目。
- 不得重新引入 Fanto 的依赖、路径、路由、部署脚本或配置。
- `apps/murder-mystery-api` 是游戏状态、规则、SQLite、Scheduler 与 AI Player Runtime 的 source of truth。
- `apps/murder-mystery-web` 只消费 API `RoomView` 并渲染 UI，不在前端复制游戏规则。
- `packages/murder-mystery-shared` 维护前后端共享契约。

## 不可破坏的架构约束

- **GameDirector 负责规则，不调用 LLM。** 它决定轮次、顺序、完成条件与阶段推进。
- **Scheduler 负责何时激活谁，不决定角色内容。** Scheduler 必须保持确定性代码，不改造成 Agent。
- **Player Agent 负责角色行为。** AI 自主决定发言、提问、沉默、搜证、公开/隐藏线索和投票。
- **AI 对游戏状态的有效写入必须通过 Tool。** 普通 assistant 文本不是公开发言。
- **角色信息严格隔离。** AI Player 不得看到其他角色的 `privateStory`、`secrets`、私有线索或最终 `truth`。
- **Agent Session 必须按 `(roomId, playerId)` 隔离。** 同角色跨房间也不能共享会话。
- **`pass` 与 `finish_round` 语义不可合并。** `pass` 只结束当前 activation，后续新公共状态仍可再次激活；`finish_round` 表示永久结束当前玩家本轮参与，本轮后续不再激活。
- **删除房间必须结束运行时生命周期。** 清理 Scheduler nudge/timer、abort 当前 Agent、关闭 Harness、删除 Runtime cache 和持久化房间；不能只删除 localStorage。
- **定向问题不能被静默吞掉。** Pending direct question 必须 `reply_question` 或 `decline_question`。
- **自由讨论的收敛是软控制。** Scheduler 可以注入 pacing 提醒，但不能替 AI 强制决定内容。

## 修改原则

- 修改前先阅读目标模块和对应 `docs/` 文档。
- 只做当前需求需要的最小结构改动，不为假设中的未来需求提前增加抽象。
- 源码、测试、schema 与配置是可执行 source of truth；文档描述当前最终状态，不记录实施计划。
- 游戏规则、上下文边界、工具语义、配置项或用户可见行为变化时，同步更新文档。
- 不提交真实 API Key、生产环境文件或用户 SQLite 数据。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @ai-murder-mystery/web lint
```
