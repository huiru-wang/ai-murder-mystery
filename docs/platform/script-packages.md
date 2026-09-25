# 剧本包、导入与版本

## 当前定位

剧本内容不进入 TypeScript 源码。平台负责流程状态机、信息隔离、AI 工具和控场；剧本包只声明故事、角色、地点、线索、真相与支持范围内的阶段编排。当前实现支持 `schemaVersion: "1.0"`。

没有已发布剧本时，服务正常启动并返回空剧本库。首页展示导入入口；导入成功仅发布剧本，不自动创建房间。用户必须选中一个剧本后，才可创建 Room。

## 导入生命周期与存储

```text
ZIP 上传或启动种子目录
  ↓
临时写入、解压、结构和语义校验
  ↓
标准化 ScriptDefinition
  ↓
SQLite script_versions.definition_json
  ↓
剧本库可选；创建 Room 时钉住 scriptVersionId
```

上传包不会保存到配置的剧本目录。导入器校验结束后会删除临时目录，v1 仅保存标准化定义，不保存原 ZIP、包内 `README.md` 或 `assets/`。因此 SQLite 不是“压缩包仓库”，而是可运行剧本定义的存储。

`AI_MURDER_MYSTERY_SCRIPT_PACKAGE_DIR` 是可选的启动种子目录：服务启动时扫描其下 `.zip` 并走同一条导入路径。适合开发或部署预置内容；未配置或目录不存在时，剧本库为空。它不是上传剧本的落盘目录。

## ZIP 结构与校验

完整字段格式以 [Skill 的 v1 格式参考](../../skills/murder-mystery-script-creator/references/package-format-v1.md) 和实际导入器为准。导入会校验：

- 包大小为 1–10 MiB，归档条目为 3–64 个；
- 仅有一个根目录，根目录名必须等于 `manifest.id`；拒绝绝对路径、`..` 和反斜杠路径；
- 必须含 `manifest.json` 与 `game.json`；其他仅允许根目录的 `README.md` 或 `assets/` 中的文件；
- `schemaVersion` 必须为 `1.0`，剧本 ID 为 kebab-case，版本为 SemVer；
- 角色、地点、阶段和线索的 ID 唯一，引用必须存在；角色数必须恰好等于 `minPlayers` 与 `maxPlayers`；
- 共 5–10 个阶段：首阶段是随机顺序的逐人介绍，倒数第二阶段为投票，最后阶段为揭晓，且结束前至少有一个搜证阶段和一个额外讨论阶段；
- 支持三种讨论模式：`ordered`、`free`、`ordered_opportunity_then_free`；搜证只支持地点搜索、每人 1–3 次；
- 线索仅支持地点来源与按玩家随机分发；真相中的凶手角色必须存在。

格式通过不代表故事一定公平。Skill 提供的创作审查会额外检查时间线、自洽性、信息隔离、可发现证据与红鲱鱼设计。

## 版本与 Room 一致性

发布标识是 `scriptId@version`。同一个标识再次导入且内容相同会幂等返回；内容不同则拒绝，不能覆盖已发布版本。修改内容时必须提升 SemVer 版本。

剧本库对每个 `scriptId` 展示最新已发布版本；创建 Room 时，Room 保存实际的 `scriptVersionId`。因此导入新版不会改写旧房间正在进行或已经结束的故事。

## HTTP 与当前边界

| 操作 | 当前接口 / 行为 |
| --- | --- |
| 列出可选剧本 | `GET /api/scripts` |
| 导入剧本 | `POST /api/scripts/import`，`multipart/form-data`，文件字段为 `package` |
| 创建房间 | `POST /api/rooms`，传入选定的 `scriptId` |
| 删除、取消发布、下载原包 | v1 未提供 |

导入失败会返回机器可读的 `SCRIPT_*` 错误码。应根据错误修正包再重新上传，而不是绕过校验或直接修改数据库。
