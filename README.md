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

### 让 AI 创作剧本

在本仓库中使用支持文件操作的 AI 助手（如 Codex）时，可直接复制下面的提示词。把方括号中的内容替换成你的想法；信息不足时，AI 会先向你确认，不会自行编造关键案件设定。

```text
请为 AI Murder Mystery 项目创作一个可导入的 v1 剧本包。使用仓库中的 murder-mystery-script-creator Skill，先阅读它的格式参考与创作质量检查要求，再开始创作。

我的创作想法：
- 题材 / 时代 / 地点：[例如：1930 年代上海，一场暴雨中的豪华邮轮]
- 玩家人数：[例如：6 人]
- 氛围与难度：[例如：本格推理、轻微惊悚、中等难度]
- 必须包含的角色、关系、反转或禁忌内容：[可留空]

工作要求：
1. 如果凶手、死因、关键时间线、角色动机、玩家人数或故事限制尚不明确，先用问题与我确认；不要把猜测当成既定设定。
2. 设计一个信息公平、可以通过公开讨论、地点搜证和投票推理出真相的案件。每位角色都要有公开身份、私密故事、目标、秘密和关系；不得让角色知道其他角色的私密信息或最终真相。
3. 不修改游戏源码、规则、schema 或现有剧本。只在 [输出目录，例如：data/scripts/我的新剧本] 创建剧本源文件，并生成 [输出目录，例如：data/scripts/我的新剧本.zip]。
4. ZIP 必须只有一个根目录，根目录名必须等于小写连字符剧本 ID；其中必须包含 manifest.json 和 game.json，可包含 README.md。不要把 ZIP 外层再套一层目录。
5. 使用真实导入器验证生成结果：
   pnpm --filter @ai-murder-mystery/api exec tsx ../../skills/murder-mystery-script-creator/scripts/validate-package.ts [ZIP 的绝对路径]
6. 如果验证失败，修复后重复验证，直到通过。最后告诉我剧本 ID、ZIP 的绝对路径、案件概要和验证结果。
```

## 本地开发

```bash
git clone git@github.com:huiru-wang/ai-murder-mystery.git
cd ai-murder-mystery
pnpm install
cp apps/murder-mystery-api/.env.example apps/murder-mystery-api/.env
```

打开 `apps/murder-mystery-api/.env`，填写真实模型 Key，例如：

```env
DEEPSEEK_API_KEY=你的_API_Key
```

再启动项目：

```bash
pnpm start:local
```

打开：

- Web：`http://127.0.0.1:5173`
- API：`http://127.0.0.1:3200`

未配置有效 Key 时，API 不会启动。

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
