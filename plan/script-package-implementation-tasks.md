# 可导入剧本包实施任务

## 0. 先决策与边界冻结

- 确认 v1 只支持固定的四类通用 phase：讨论、搜证、投票、揭晓；并固化首轮 ordered introduce、末尾 vote/reveal、phase 数量区间与配额上限。
- 确认 v1 的人数策略：建议第一期所有角色必须参与，随后才增加可选角色/席位组合。
- 确认剧本导入权限、资产存储位置、最大包体积与发布审核责任人。
- 产出：ADR、版本化 schema 范围、错误码清单。

## 1. 抽离剧本领域模型与不可变仓库

- 将当前 `ScriptDefinition` 从源代码常量依赖改为可序列化领域模型。
- 增加 `ScriptPackageRepository` / `ScriptVersionRepository`，并让 Room 使用内部 version 主键。
- 将现有《第七码头》转化为 v1 包，作为回归夹具；其 TypeScript 常量仅在迁移期保留。
- 验证：旧剧本导入后能生成相同的角色、线索、阶段和结局投影。

## 2. 定义并实现 ZIP 规范与校验器

- 提交 JSON Schema、规范化规则、ZIP 白名单和模板包。
- 实现路径安全、大小/压缩比限制、哈希计算、JSON Schema 与跨引用语义校验。
- 实现阶段可达性/完成性静态检查和最小 deterministic simulation；包含首轮/终局流程契约、discussion 配额与时限、关键线索可发现性检查。
- 验证：为每类失败输入编写单元测试与结构化诊断断言。

## 3. 建立导入、草稿、预览与发布链路

- 新建持久化表、迁移、资产存储抽象与审计记录。
- 提供导入、读取校验报告、预览、发布、列出已发布版本的管理 API。
- 实现同内容及 `id + version` 冲突规则，并确保发布事务原子性。
- 验证：失败导入不留下可用剧本，发布版本重启后仍可被查询与建房。

## 4. 将 GameDirector 改为 phase 声明驱动

- 用 phase `kind/configuration/completion` 消除 `introduction` 和固定 round 顺序等业务判断。
- 将特定 `PlayerRoundStateRecord` 字段迁移至通用 phase 状态模型或受控适配器。
- 把轮次开始事件、参与范围、轮序、完成条件和下一阶段计算都改为从已钉住版本读取。
- 验证：至少用两个角色数、阶段顺序不同的 fixture 跑完整局集成测试。

## 5. 将命令、线索和 Scheduler 改为能力驱动

- 从 phase 声明派生动作授权、参数约束和配额；不再假设每一搜证轮均为地点搜证。
- 让 Scheduler 依据 phase 能力生成 trigger，不依赖剧本或 round ID。
- 保持现有的确定性、问题不可吞、`pass`/`finish_round` 语义和 Room 生命周期约束。
- 验证：命令越权、无效对象、配额超限、不同分发策略及阶段完成条件均被覆盖。

## 6. 更新 Agent Context 与共享 API/UI 契约

- 用 phase 的通用说明、required action 与可操作对象构造 Agent prompt，移除所有固定 ID 条件。
- 按可见性投影读取角色、线索、真相和复盘数据，增加防泄露测试。
- 扩展 `RoomView` 以表达 phase 展示语义与具体可用动作；Web 完全根据 API 渲染。
- 验证：prompt snapshot、前后端契约测试和两份不同剧本 E2E 测试通过。

## 7. 创作工具与剧本 Create Skill

- 增加剧本模板、示例包、作者 README、校验器 CLI 和 Create Skill。
- Skill 只生成本地可审阅的包和校验报告；用模板、schema 和 validator 约束 Agent 产物。
- 验证：用一个全新的故事梗概生成包，人工审阅后可一键导入预览环境。

## 8. 迁移、可观测性与上线

- 将现有数据/《第七码头》迁入发布版本，制定旧 Room 回滚与兼容策略。
- 监控导入失败原因、校验耗时、包大小、发布次数、Room 按剧本版本完成率和 Agent 失败率。
- 更新架构、运行时、开发和剧本作者文档；执行完整 typecheck、unit、integration、E2E 与安全测试。
- 分阶段上线：内部草稿导入 → 受限发布 → 普通作者导入。
