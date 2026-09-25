# AI Player Architecture

## 一个 AI Player 是什么

每个 AI 玩家都是独立的 Agent Session，而不是一次性的模型调用，也不是一个模型同时扮演整桌所有角色。

绑定关系为：

```text
(roomId, playerId)
      ↓
Agent Session
```

这保证：

- 同一个房间中的不同 AI 不共享私人上下文。
- 同一个角色在不同房间中也完全隔离。
- 一个 AI 在整局游戏中可以保留持续会话历史。

## 信息隔离

AI Player 只允许看到：

- 剧本公共背景
- 所有玩家公开身份
- 当前公共线索
- 当前公共时间线
- 自己的角色完整私人信息
- 自己获得的私有线索
- 发给自己的 pending question
- 当前轮次和自己的行动状态

普通游戏阶段不会把以下信息注入 AI Player：

- 其他角色的 `privateStory`
- 其他角色的 `secrets`
- 其他角色私有线索
- 剧本最终 `truth`

角色允许根据自己的 deception policy 隐瞒或对自己的行为撒谎，但禁止凭空创造世界事实。

## Context Builder

AI 上下文分成两层。

### System Context

Session 创建时构建稳定的角色和规则上下文，主要包括：

- 你是剧本杀玩家，不是主持人或助手
- 剧本公共背景
- 自己的角色身份、职业和 public profile
- 自己的 `privateStory`
- `knownFacts`
- `secrets`
- `goals`
- `relationships`
- `deceptionPolicy`
- 信息隔离规则
- Tool 使用规则
- 自由讨论中“有信息增量才公开行动”的原则
- `pass` 与 `finish_round` 的语义

System Prompt 版本通过 Agent revision 管理。重要 Prompt 变化时提升 revision，旧 Session 会被重新创建，避免代码已经升级而旧房间继续吃旧规则。

### Dynamic Context

每次 Scheduler 激活 AI 时重新构建，反映当前实时游戏状态。主要包括：

- 本次 Trigger 及触发原因
- 当前 Round / Discussion mode
- 本次允许使用的 Tools
- 所有玩家公开身份
- 当前公开线索
- 自己尚未公开的私有线索
- 当前完整公共 Timeline
- Pending direct question
- 搜证地点、搜证额度和搜证状态
- Scheduler pacing / 收敛提醒

Dynamic Context 的作用是让同一个长期 Agent Session 在每次被激活时重新对齐当前游戏状态，而不是只依赖历史消息自行猜测。

## 一次 Agent Activation

```text
Scheduler Trigger
      ↓
Context Builder
      ↓
Agent Session.prompt(dynamicPrompt)
      ↓
LLM
      ↓
Tool Call
      ↓
RoomCommandService
      ↓
Room / Event / Round State
```

普通 assistant 文本不会自动显示给玩家。公开发言必须通过 `send_message`，定向回答必须通过 `reply_question` 等工具。

## Tool-driven Action

当前 AI 可以使用的核心工具包括：

### 讨论

- `send_message`
- `ask_player`
- `reply_question`
- `decline_question`
- `pass`
- `finish_round`

### 搜证

- `search_clue`
- `reveal_clue`
- `keep_clue_private`
- `finish_search`

### 投票

- `submit_vote`

Tools 不只是格式约束，而是游戏状态机的一部分。只有 Tool 成功执行，才算真实游戏动作。

## `pass` 与 `finish_round`

两者语义必须严格分开。

### `pass`

表示：

> 我已经看到当前公共状态，但这次没有值得公开的新内容。

效果：

- 不产生群聊消息
- 结束当前 Agent activation
- 后续出现新的公共状态时，仍可以再次被 Scheduler 激活

因此 `pass` 是“暂时沉默”，不是“退出本轮”。

### `finish_round`

表示：

> 我认为自己这一整轮讨论已经完成，后续即使本轮再出现新消息也不再参与。

效果：

- 设置 `discussionFinished=true`
- 当前轮次内 Scheduler 不再激活该 AI
- GameDirector 会将它视为已完成本轮

所有玩家都 `discussionFinished=true` 且没有 pending question 时，自由讨论才可以推进。

## Direct Question

定向问题不能被普通 `pass` 静默吞掉。

当存在发给自己的 pending question 时，AI 必须：

- `reply_question`
- 或 `decline_question`

Runtime 会拒绝在 pending question 状态下执行 `pass`。

## Tool Call 可靠性

某些模型可能会输出普通文本而不调用 Tool。Runtime 对自由讨论做两级处理：

1. 第一次 completed 但 `toolCount=0` 时，再次提示模型把刚才的意图转换成 Tool。
2. Recovery 后仍然没有 Tool：
   - 普通自由讨论：自动 `pass`，避免整个 Scheduler 被卡住，同时不伪造公开发言。
   - `nudge`：自动 `finish_round`，保证一次催促能够收敛。
   - `direct_question`：保持失败，不允许静默吞掉明确问题。

Provider 本身的错误，例如鉴权失败、余额不足或模型不存在，不会被这些兜底伪装成正常玩家动作。
