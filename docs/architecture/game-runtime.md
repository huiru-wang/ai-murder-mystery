# Game Runtime 与 Scheduler

## Round 状态机

每个 Room 的 Round 顺序由创建时钉住的 `ScriptDefinition` 版本决定。以下是 v1 的结构，而不是固定剧本流程：

```text
作者自定义的首阶段（ordered + requiredAction: introduce）
  ↓
至少一个讨论和一个搜证阶段（作者定义顺序与数量）
  ↓
投票（固定倒数第二阶段）
  ↓
揭晓（固定最后阶段）
```

v1 支持 5–10 个阶段；阶段 ID、标题、讨论模式、搜证次数、角色、地点和线索均由剧本包声明。格式约束见[剧本包文档](../platform/script-packages.md)。

GameDirector 是这套状态机的唯一规则入口。

## GameDirector

### Ordered Discussion

自我介绍属于 ordered discussion。

- Round 开始时会为所有玩家生成随机 `turnOrder`。
- `turnOrder` 持久化，页面刷新或服务重启不会重新洗牌。
- 每个玩家必须完成一次公开发言。
- 当前轮到真人时 Scheduler 会阻塞等待真人。
- 当前轮到 AI 时 Scheduler 产生 `scheduled_opportunity`。

### Free Discussion

自由讨论的完成条件是：

```text
没有 pending question
AND
所有玩家 discussionFinished = true
```

`pass` 不会完成整轮，只有 `finish_round` 才会设置 `discussionFinished`。

### Search

每个玩家拥有独立 `actionsPerPlayer` 配额。某个地点或某条线索不会因为另一个玩家先搜到就全局失效。

### Vote

每个玩家独立提交一次密封投票。全部投票完成后进入 Reveal。

## Scheduler 是什么

Scheduler 不是 Agent，也不调用 LLM 来决定游戏规则。

它是一个确定性的控场器，主要职责是：

> 根据当前 Room / Round / Player state，判断现在是否应该激活某个 AI，以及用什么 Trigger 激活。

Scheduler 与 Player Agent 的责任边界：

```text
Scheduler：你现在该不该重新思考？为什么？
Player Agent：我现在具体想做什么？
```

## Trigger

当前主要 Trigger 包括：

- `nudge`：真人催促指定 AI 尽快行动或结束本轮。
- `direct_question`：AI 收到明确的 pending question。
- `scheduled_opportunity`：ordered round 当前轮到该 AI。
- `round_started`：free discussion 开始，AI 获得首次参与机会。
- `public_state_changed`：公共状态发生变化，尚未处理该状态的 AI 再次获得判断机会。
- `search_turn`：AI 需要完成搜证动作。
- `vote_requested`：AI 尚未提交投票。

Scheduler 每次只选择一个 Trigger，等待对应 Agent run 完成后重新读取房间状态，再判断下一个动作。因此 AI 玩家之间不是同时基于同一个旧快照并发抢答，后执行的 AI 可以看到前面玩家刚刚产生的新公开信息。

## 自由讨论如何持续

自由讨论中，公共状态变化会让尚未结束本轮的 AI 再次获得判断机会。

```text
新的公共状态
   ↓
Scheduler 发现 AI 仍未 finish_round
   ↓
public_state_changed
   ↓
Agent 读取最新上下文
   ↓
send_message / ask_player / pass / finish_round
```

系统不使用“每条消息必定触发一次回复”的机制。Scheduler 关注的是“AI 是否还有尚未处理的公共状态”，不是机械地把每条 Event 映射成一次回复。

## Nudge

Nudge 是强收敛 Trigger。

被真人催促后，AI 不能使用 `pass`：

- 有新的关键内容：立即公开行动。
- 没有新的关键内容：立即 `finish_round`。

如果模型在 nudge recovery 后仍然不调用 Tool，Runtime 会直接 `finish_round`，避免需要真人连续点击多次催促。

## Scheduler 软性控场

自由讨论允许 AI 自主决定展开深度，但 Scheduler 会根据确定性指标判断是否应该提醒收敛。

达到以下任意阈值时进入 `should_wrap_up`：

- 当前自由讨论持续分钟数达到配置值
- 当前轮公开交流事件数量达到配置值
- 当前轮 AI activation 总数达到配置值

配置项：

```env
AI_MURDER_MYSTERY_DISCUSSION_PACING_AFTER_MINUTES=8
AI_MURDER_MYSTERY_DISCUSSION_PACING_MESSAGE_COUNT=30
AI_MURDER_MYSTERY_DISCUSSION_PACING_ACTIVATION_COUNT=45
```

进入收敛状态后：

1. 当前轮只发布一次 `discussion_pacing_reminder` 公共系统事件，真人和 AI 都能看到。
2. 后续 AI Dynamic Prompt 带上当前时长、公开交流数、activation 数以及已结束玩家数。
3. Prompt 建议 AI 在没有关键新内容时倾向 `finish_round`，但仍允许继续讨论。

无论是否达到阈值，Scheduler 在每一次自由讨论 Trigger 中都会注入当前已持续时间、公开交流数、AI 激活数、已结束人数以及三项配置阈值。Agent 因而从第一次被唤醒起就知道本轮讨论有限，若有关键事实、推理或必须追问的问题，应尽快通过工具表达，而不是等待系统进入收敛状态才开始展开。

这是一种“确定性检测 + Agent 自主决定”的软控制，不让 Scheduler 替角色做内容判断。

## 房间生命周期

### Active Room 恢复

API 启动后会扫描仍处于 active 状态的 Room 并 `kick` Scheduler。Agent Session 缺失或 revision 不兼容时，会创建新的 Session。

### Remove Room

“移除房间”不是只删除前端记录，而是完整结束该房间生命周期：

```text
用户移除房间
   ↓
Scheduler 标记 room removed
   ↓
清理 nudge queue / pacing timer
   ↓
abort 当前房间 Agent lane
   ↓
关闭 Harness / 清理 Runtime cache
   ↓
删除 Room 持久化数据
   ↓
前端删除本地引用
```

删除后：

- 不再产生新 AI 消息
- 不再触发新的 Agent run
- 重启 API 后也不会被 `resumeActiveRooms()` 恢复
