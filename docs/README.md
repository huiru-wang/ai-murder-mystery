# Documentation

## 剧本平台与创作

- [剧本包、导入与版本](./platform/script-packages.md) — 当前 ZIP 格式、校验、SQLite 持久化、版本规则和 API 边界。
- [剧本创作 Skill 使用说明](./authoring/script-creator.md) — 如何用现有 Skill 把故事制作成可导入的剧本包，以及本地验证方式。

## 产品

- [产品逻辑](./product/product.md) — 产品是什么、玩家如何完成一局游戏、AI 玩家在用户侧如何表现。

## 核心架构

- [整体架构](./architecture/overview.md) — Web、API、GameDirector、Scheduler、Player Agent、Tools 和 SQLite 的职责边界。
- [AI Player 架构](./architecture/ai-player.md) — 独立 Agent Session、信息隔离、上下文构建、Tool 驱动行为、`pass` / `finish_round`。
- [Game Runtime 与 Scheduler](./architecture/game-runtime.md) — 轮次状态机、Trigger 调度、自由讨论、软性控场和房间生命周期。

## 工程

- [开发、配置与测试](./engineering/development.md) — 本地启动、环境变量、live/mock 模式、SQLite 与验证命令。
- [部署](./engineering/deployment.md) — 当前生产部署方式、Nginx、运行目录和重启限制。
