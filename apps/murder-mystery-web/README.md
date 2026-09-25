# Murder Mystery Web

在线剧本推理游戏前端。它只消费 Murder Mystery API 返回的 RoomView，不自行编码游戏流程。

开发：

~~~bash
pnpm dev:api
pnpm dev:web
~~~

Vite 通过 `/api` 代理本地 API 的 3200 端口。

核心交互：

- 在没有剧本时展示导入入口；导入 ZIP 仅刷新剧本库，不自动创建房间；
- 在固定高度、可滚动的剧本库中选择剧本，再主动创建房间；
- 选择角色；
- 查看自己的私密剧本；
- 根据 availableActions 参与讨论、结构化 @ 提问与回复；
- 搜证并决定是否公开私有线索；
- 明确提交“本轮没有补充”；
- 密封投票；
- 真相复盘。

生产基路径为 `/`。
