# 剧本创作 Skill 使用说明

## 适用场景

仓库已有 [`murder-mystery-script-creator`](../../skills/murder-mystery-script-creator/) Skill。它用于把一个故事想法、已有大纲或已完成剧本，制作或修订为可导入的 v1 ZIP；不需要为了新增剧本修改游戏源码。

Skill 与作者先确认玩家人数、凶案时间线、凶手与动机、每个角色的公开与私密信息、地点、线索计划和最终真相；再按平台格式生成包。它会保留未确认的创作选择为待确认项，不把猜测伪装成既定设定。

## 推荐工作流

1. 向 Agent 提供故事设定，要求使用 `murder-mystery-script-creator` 创作或修订剧本。
2. 完成故事与角色的必要确认，并进行线索公平性审查。
3. 生成单根目录 ZIP：根目录名等于剧本 ID，内含 `manifest.json` 和 `game.json`。
4. 使用实际导入器的本地验证命令校验 ZIP。
5. 验证通过后，在首页导入 ZIP；导入仅加入剧本库，选择剧本后再创建房间。

```bash
pnpm --filter @ai-murder-mystery/api exec tsx ../../skills/murder-mystery-script-creator/scripts/validate-package.ts /absolute/path/to/package.zip
```

此命令使用内存数据库运行 API 的真实 `ScriptPackageImporter`，是兼容性门槛。每次修改 `manifest.json`、`game.json`、归档结构或版本后都应重新运行。

## 创作自由与平台边界

作者可自由决定时代、地点、案件、角色、动机、叙事文本、地点、线索内容和支持范围内的讨论/搜证阶段编排。平台固定的是可运行契约：首阶段为随机顺序自我介绍、结尾为投票与揭晓、支持的阶段类型与工具、ZIP 白名单和信息隔离规则。

如果故事需要自定义机制、可执行逻辑、全新阶段类型、变量人数或包内素材展示，不应把它伪装成 v1 字段。应说明其不受当前导入器支持，并另行提出平台能力变更。

详细 JSON 字段见 [v1 格式参考](../../skills/murder-mystery-script-creator/references/package-format-v1.md)，创作质量检查见 [Authoring review](../../skills/murder-mystery-script-creator/references/authoring-review.md)。
