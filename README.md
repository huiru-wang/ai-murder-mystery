# AI Murder Mystery

一个人与 AI 玩家共同完成的在线剧本推理游戏。

选择剧本、创建房间、扮演角色，然后与拥有各自秘密、动机和线索的 AI 玩家一起讨论、搜证、质询、投票，最终还原真相。

## 开始游戏

1. 启动项目。
2. 在首页导入剧本 ZIP；首次启动没有剧本时，首页会直接显示导入入口。
3. 从剧本库选择一个剧本，点击“创建新房间”。
4. 选择你的角色，开始游戏。

「data/scripts」下内置了2个剧本，启动后自动加载到数据库。

## 创作你的剧本

用 [`murder-mystery-script-creator`](./skills/murder-mystery-script-creator/) 把故事变成可导入 ZIP。你可以自由设定案件、角色、地点、线索与支持范围内的流程，再导入到剧本库游玩。

剧本格式与创作步骤见[剧本创作指南](./docs/authoring/script-creator.md)。

## 本地开发

```bash
git clone git@github.com:huiru-wang/ai-murder-mystery.git
cd ai-murder-mystery
pnpm install
cp apps/murder-mystery-api/.env.example apps/murder-mystery-api/.env
pnpm start:local
```

打开：

- Web：`http://127.0.0.1:5173`
- API：`http://127.0.0.1:3200`

填写模型 Provider 的 API Key 后即可使用真实 AI。若只想体验流程，可在 `.env` 中设置：

```env
AI_MURDER_MYSTERY_AI_MODE=mock
```

## 常用操作

```bash
pnpm start:local
pnpm typecheck
pnpm test
pnpm build
pnpm deploy
```

## 进一步了解

- [剧本创作与导入](./docs/authoring/script-creator.md)
- [剧本包格式与版本规则](./docs/platform/script-packages.md)
- [开发与部署](./docs/engineering/development.md)
