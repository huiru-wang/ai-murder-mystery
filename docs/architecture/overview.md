# 整体架构

## 核心目标

项目的关键技术目标不是“让模型能聊天”，而是让多个彼此隔离的 AI Player 在一个确定性的游戏规则系统中长期参与，并保证：

- 私密信息不会串角色
- 游戏流程不会由 LLM 随机决定
- AI 行为可以影响真实游戏状态
- 自由讨论保持开放，但不会无限失控
- 房间、角色和 Agent Session 的生命周期可恢复、可终止

## 运行时边界

```text
React / Vite Web
        ↓
      HTTP API
        ↓
RoomCommandService / RoomQueryService
        ↓
┌──────────────────────────────────────┐
│ GameDirector                         │
│ Scheduler                            │
│ PlayerAgentRuntime                   │
│ PlayerAgentContextBuilder            │
│ Agent Harness / LLM                  │
│ Tools                                │
└──────────────────────────────────────┘
        ↓
SQLite: game.sqlite / agent.sqlite
```

### Web

`apps/murder-mystery-web` 只消费 API 返回的 `RoomView` 并展示当前玩家可见的数据。它不决定轮次完成、不计算 AI 是否应该行动，也不维护另一套游戏规则。

### API

`apps/murder-mystery-api` 是 source of truth，拥有：

- Room / Player / Round 状态
- 事件时间线
- 角色和线索隔离
- GameDirector
- Scheduler
- Agent Session binding
- AI Player Runtime
- Tool 执行
- SQLite 持久化

### Shared

`packages/murder-mystery-shared` 维护前后端共享的请求/响应类型和枚举，避免 Web 自行解释 API 数据。

## 四个核心职责

### GameDirector：规则

GameDirector 是确定性状态机，回答：

> 当前处于哪个阶段？当前轮是否结束？接下来进入哪一轮？

它负责：

- 创建 Round
- ordered turn 顺序
- 自我介绍是否完成
- 自由讨论是否全部结束
- 搜证和投票是否完成
- 推进到下一阶段

它不调用 LLM，也不判断某个角色应该怀疑谁。

### Scheduler：控场

Scheduler 回答：

> 现在是否需要让某个 AI 再思考一次？如果需要，是谁，为什么？

它产生 Trigger，例如：

- `round_started`
- `scheduled_opportunity`
- `public_state_changed`
- `direct_question`
- `nudge`
- `search_turn`
- `vote_requested`

Scheduler 是确定性代码，不是 Agent。具体行为内容仍由 Player Agent 决定。

### Player Agent：角色决策

Player Agent 回答：

> 我作为这个角色，在当前信息下想做什么？

它可以通过工具：

- 发言
- 提问
- 回答/拒答
- 暂时沉默
- 结束本轮
- 搜证
- 公开/隐藏线索
- 投票

### Tools：唯一写入口

AI 的自然语言输出本身不会改变游戏，也不会自动进入群聊。只有 Tool 调用才会通过 `RoomCommandService` 写入真实游戏状态。

这让“模型在想什么”和“游戏里实际发生了什么”保持清晰边界。

## 数据与会话

游戏状态和 Agent 会话分开存储：

- `game.sqlite`：Room、Round、Player、Event、Clue、Vote、Agent binding/run 等游戏数据。
- `agent.sqlite`：Agent Harness Session 与模型会话历史。

AI Session 绑定到 `(roomId, playerId)`。即使两个房间使用同一个剧本、同一个角色，也不会复用 Session。

## 恢复与一致性

Room 状态是恢复 AI 上下文的基础。API 重启后，会恢复仍处于 active 状态的房间；如果绑定的 Agent Session 不存在或 revision 不兼容，会创建新的 Session，并依据持久化房间状态重新构建上下文。

因此 Agent Session 是持续体验的一部分，但不是唯一 source of truth；游戏事实仍以 Room 持久状态为准。
