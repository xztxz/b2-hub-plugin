# B2 宿主契约 v1.2

**这份文档是共享接口，DESIGN.md 是项目叙事。** 实现一个新宿主（VSCode 扩展、网页、公司内部服务、命令行脚本）只需要读这一份；不需要读 DSH 插件的任何一行代码。两者冲突时以本文档为准。

契约描述的是**行为**，不是实现：任何语言、任何进程，只要满足这里的行为，就是合规宿主。

---

## 1. 库根与目录

**总不变量**：宿主界面上的一切创建与变更（截止日、归属、负责人、完成状态）都必须立刻落成文件变更。文件是唯一真相源；界面不得持有 Markdown 之外的业务状态（只读缓存除外）。

- 库根由每个宿主自行配置，默认 `~/vault/B2`（推荐解析 `~`、`%VAR%`、`${VAR}` 与整串引号后再用）。**库不存在时报错，绝不自动创建**；初始化必须由用户显式触发。
- 目录结构固定：

```
<root>/
  00-Inbox/                 临时与未归类笔记
  10-Projects/<项目名>/     每个项目一个目录
    <项目名>.md             项目笔记（type: project），文件名与目录名一致
  20-People/                人员笔记（type: person）
  90-Overview.md            生成的汇总，不手工编辑
```

- 只扫描 `.md` 文件。跳过以 `.` 开头的文件与目录，以及 `node_modules`、`.obsidian`、`.dsh-backup`、`.trash`。
- 所有路径参数都是**库内相对路径**，用 `/` 分隔。绝对路径、`..` 逃逸一律拒绝。

## 2. 编码与写入

- UTF-8，**无 BOM**，换行一律 LF。读到 BOM 时解析前剥掉；任何宿主都不得写出 BOM 或 CR。
- 写入必须原子：先写同目录临时文件，再 rename 覆盖。同步工具不能读到半个文件。
- 行级编辑（勾任务、改期、指派）必须保证**其余行逐字节不变**，且保留原文件是否有末尾换行。

## 3. 笔记格式

```markdown
---
type: project            # project | person | note；缺省视为 note
status: active           # active | paused | blocked | done；仅 project 常规必填
priority: high           # low | medium | high；可选
created: 2026-11-18      # YYYY-MM-DD
due: 2026-11-25          # 可选
---

# 标题

正文……
```

- frontmatter 是扁平的 `key: value`；数组写 `[a, b]`；字符串可加引号。不支持嵌套 YAML。
- **标题解析顺序**：`frontmatter.title` → 正文第一个 `# ` 一级标题 → 文件名（去扩展名）。
- 文件名由标题得出：删除 `..` 序列，`\ / : * ? " < > |` 与控制字符替换为 `-`，连续空白折叠为一个空格，去掉首尾的 `.`、`-`、空格；结果为空时用 `未命名`。

## 4. 任务行

```markdown
- [ ] 任务标题 📅2026-11-20 @张三 ⏱ 2h #标签
- [x] 已完成的任务
```

- 标记：`-` 或 `*`；状态 `[ ]`（未完成）或 `[x]`／`[X]`（已完成）；允许缩进。
- 截止日：`📅YYYY-MM-DD`，兼容旧写法 `due::YYYY-MM-DD`。
- 指派：`@[[姓名]]`（推荐，Obsidian 双链，会出现在人员笔记的反向链接里）；兼容纯文本 `@姓名`。一人一个词、不含空格；**一个任务可以有多名负责人**，按出现顺序写多个 `@`，解析时去重保序。
- 人员笔记会由 `syncPeople` 生成 `## 任务` 段，用 `[[笔记名]]` 双链指回任务所在笔记，形成双向链接。
- 工时：`⏱ 2h`（可选）。标签：`#标签`（可选）。
- 标题 = 去掉 `📅`/`due::`/`⏱`/`@姓名` 后的剩余文本，压缩空白；`#标签` 保留在标题里，同时另行解析为 `tags`。
- **`line` 一律指整文件行号（1 起，含 frontmatter 行）**，供行级编辑直接定位。

## 5. 操作契约

| 操作 | 输入 | 成功输出 | 失败 |
|---|---|---|---|
| `listNotes` | `type?`, `query?` | `[{path, type, title, status?, due?, updated}]` | `ROOT_MISSING` |
| `readNote` | `path` | `{path, frontmatter, body, hash, size, updated}` | `NOT_FOUND` |
| `createNote` | `title`, `type?`, `folder?`, `body?`, `frontmatter?` | `{path, hash}` | `ALREADY_EXISTS`、`OUTSIDE_ROOT` |
| `writeNote` | `path`, `expect`, `frontmatter?`, `body?` | `{path, hash, previousHash, conflict}` | `NOT_FOUND` |
| `listTasks` | `scope?`（all/project/inbox）, `assignee?`, `includeDone?` | `[{path, line, title, done, due?, assignees, effort?, tags}]` | `ROOT_MISSING` |
| `toggleTask` | `path`, `line`, `expect`, `done?` | `{path, hash, conflict, done}` | `NOT_A_TASK_LINE`、`LINE_OUT_OF_RANGE` |
| `setDue` | `path`, `line`, `expect`, `due?` | `{path, hash, conflict, due?}` | `INVALID_DATE` |
| `assign` | `path`, `line`, `expect`, `name?` / `names?`, `action?`（add/remove） | `{path, hash, conflict, assignees, names, action}` | `INVALID_ARGS`、`NOT_FOUND` |
| `overview` | — | `{path, hash, projects}` | `ROOT_MISSING` |
| `capture` | `text`, `target?`（省略或 inbox 进收件箱） | `{path, text, created, assignees, hash}` | `INVALID_ARGS`、`NOT_FOUND` |
| `moveTask` | `path`, `line`, `target` | `{path, from, moved, title?}` | `NOT_FOUND`、`NOT_A_TASK_LINE` |
| `setAssignees` | `path`, `line`, `expect`, `names` | `{path, hash, conflict, assignees, names}` | `NOT_FOUND`、`INVALID_ARGS` |
| `setAssignee` | `path`, `line`, `expect`, `name?` | `{path, hash, conflict, assignees}` | `NOT_FOUND`、`INVALID_ARGS` |
| `personHistory` | `name` | `{name, role?, active, done}` | `NOT_FOUND` |
| `initLibrary` | — | `{root, created, fresh}` | 文件系统错误原样上报；不覆盖已有文件 |

> `capture` / `moveTask` / `setAssignee` / `personHistory` / `initLibrary`（v1.1）与 `setAssignees`（v1.2）是**可选能力**：不实现它们仍是合规 v1 宿主；实现了就要满足这里的输入输出与错误码。

语义补充：

- `listNotes.query`：大小写不敏感，匹配 `路径 + 标题`。
- `createNote` 默认落位：`project` → `10-Projects/<标题>/<标题>.md`；`person` → `20-People`；`note` → `00-Inbox`。默认 frontmatter `{type, created: 今天}`，`project` 另加 `status: active`。默认正文 `# <标题>\n`。文件内容 = frontmatter + 一个空行 + 正文。**同名文件已存在时报错，不覆盖。**
- `writeNote`：`frontmatter` 提供时与现有字段浅合并；`body` 提供时整体替换正文；省略即保留原值。输出前缀始终是 `frontmatter + 空行 + 正文`。
- `toggleTask`：只改该行的 `[ ]`/`[x]` 标记；`done` 省略表示取反。
- `setDue`：先删掉该行已有的日期标记；`due` 为空表示清除；否则插在第一个 ` @` 之前，没有指派就追加到行尾。
- `assign`：`add` 幂等（已存在不重复）；`remove` 删除该人的所有 `@` 标记并整理多余空格。`name` 与 `names` 可同时给，合并去重后按顺序处理；**只动指定的那几个人，名单里的其他负责人原样保留**。姓名不得含空格、`@`、`#`。
- `overview`：整体覆盖 `90-Overview.md`，不走冲突检测；它是生成物。
- `capture`：正文里已知人员的 `@姓名` 必须升级成 `@[[姓名]]`（Obsidian 反向链接只认双链）；`created: true` 表示这次顺手建了收件箱。
- `moveTask`：整行搬移，日期/指派/勾选状态原样保留；目标与来源相同则 `moved: false`。
- `setAssignees`：替换式（与 `assign` 的增删不同）：清掉该行现有 `@`，按 `names` 顺序写回，`names: []` 即清空；传空名字时报错，不会静默清空。
- `setAssignee`：单人版 `setAssignees`（`name` 为空即清空），保留给只支持单人负责人的老宿主/老调用方。
- `initLibrary`：只建四个一级项；仅当库根本来不存在（`fresh: true`）时放 1 个示例项目 + 1 个示例人员；重复调用幂等，永不覆盖。

## 6. 冲突策略

- `expect` = 读取时得到的 `hash`。`hash` 是**整篇文件 UTF-8 字节的 SHA-256 十六进制串（64 位）**；为便于显示，允许只传前 ≥10 位前缀，宿主按前缀匹配。
- 写入前重新计算当前 hash：与 `expect` 一致 → 正常写；不一致 → **仍然写入（最后写入赢）**，同时返回 `conflict: true`，由调用方提示「可能覆盖了别处的修改」。
- 不做自动合并、不做备份、不做撤销。这是明确的取舍。

## 7. 排序与默认值

- 笔记按 `path` 升序（本地化字符串比较）。
- 任务按 `due` 升序；无截止日的排最后；同 `due` 按 `path`、再按 `line`。
- frontmatter 缺 `type` 视为 `note`；缺 `title` 走标题解析顺序；缺失的 `status`/`due` **省略该字段**（不输出 `null`，也不输出空字符串）。
- `type: person` 的人员笔记可带 `role`（角色），名字取标题；任务行里的 `@姓名` 指向这类笔记的标题。

## 8. 错误码

| 码 | 含义 |
|---|---|
| `ROOT_MISSING` | 库根不存在或不是目录（**不自动创建**） |
| `NOT_FOUND` | 笔记不存在 |
| `ALREADY_EXISTS` | 建笔记时同名文件已存在 |
| `OUTSIDE_ROOT` | 路径逃出库根（绝对路径、`..`） |
| `LINE_OUT_OF_RANGE` | 行号超出文件行数 |
| `NOT_A_TASK_LINE` | 目标行不是 checkbox 任务 |
| `INVALID_DATE` | 日期不是合法的 `YYYY-MM-DD` |
| `INVALID_ARGS` | 其他参数非法（空标题、姓名含非法字符等） |
| `FILE_TOO_LARGE` | 单个文件超过实现设定的读取上限 |

所有操作还可能在路径层返回 `NOT_FOUND`、`OUTSIDE_ROOT`、`INVALID_ARGS`。错误必须携带错误码（如 JS 的 `error.code`、其他语言的等价字段），并给出人能看懂的说明；不要只抛裸异常文本。

## 9. 概览文件格式

`90-Overview.md` 固定为：

```markdown
---
type: note
generated: <ISO-8601 时间>
---

# 90-Overview

## 项目（N）
- **<项目名>** · <status> · 📅<due> · 未完成 <n> 个 — <path>

## 逾期（N）
- ⚠️ <任务> · 📅<due> · 已过期 <d> 天 — <path>:<line>

## 本周（N）
- <任务> @<姓名> · 📅<due> — <path>:<line>

## 未指派（N）
- <任务> · 📅<due> — <path>:<line>

---

由 b2_overview 生成，可随时重新生成；不要手工编辑这一篇。
```

- 「逾期」= 截止日早于今天；「本周」= 今天起 7 天内（含今天）；「未指派」= 没有 `@` 的未完成任务。
- 空段落写 `（无）`；每个段落都必须存在，顺序固定。

## 10. 新宿主合规验证（黑盒）

在临时目录里建一个空库，按顺序跑完即视为合规：

1. `listNotes` 返回空数组；库根不存在时返回 `ROOT_MISSING`。
2. `createNote{title:"演示", type:"project"}` → 路径为 `10-Projects/演示/演示.md`，文件以 `---` 开头、含 `type: project` 与 `created`。
3. 再次 `createNote` 同名 → `ALREADY_EXISTS`，原文件字节不变。
4. `readNote` 得到的 `hash` 是 64 位十六进制；用前 12 位作 `expect` 调 `writeNote` → `conflict: false`。
5. 用错误 hash 调 `writeNote` → `conflict: true` 且内容确实被覆盖。
6. 带三个任务（一个 `📅`、一个 `@`、一个已完成）的笔记：`listTasks` 按截止日排序、无截止日最后；`includeDone:false` 时不含已完成。
7. `toggleTask` 只改该行 `[ ]`→`[x]`；再切换恢复；其余行逐字节不变。
8. `setDue` 把 `📅` 插在 `@` 之前；传空清除。
9. `assign` 加人幂等；`remove` 后不复存在；`names: ["张三","李四"]` 一次加两人后，名单顺序为 `张三、李四`，再 `remove` 其中一个另一个仍在。
10. 对非任务行、越界行号、`2026-13-01`、`../escape.md` 各调一次，分别得到对应错误码。
11. `overview` 生成的四个段落顺序与标题符合第 9 节。
12. 写出的所有文件：无 BOM、无 CR、无残留临时文件。
13. （可选能力）`capture{text:"打电话 📅2026-11-25 @张三"}` → 收件箱多一行，且已知人员的 `@张三` 变成 `@[[张三]]`。
14. （可选能力）`moveTask` 后源笔记不再有该行、目标笔记多一行且属性不变；`initLibrary` 连跑两次，第二次 `fresh:false` 且 `created` 为空。
15. （可选能力）`setAssignees{names:["张三","李四"]}` → 该行两个双链、顺序一致；`names: []` → 该行没有任何 `@`；`setAssignee{name:"张三"}` 只留一个人。

## 11. 变更流程

- 改契约 = 升版本号（v1 → v2），并同步更新 DESIGN.md 的决策记录。
- 新增可选能力不升版本；改变既有行为、字段语义或错误码必须升版本。
- v1.1（2026-11-19）：库根默认值改为可移植写法 `~/vault/B2`；新增可选能力 `capture` / `moveTask` / `setAssignee` / `personHistory` / `initLibrary`。既有操作语义未变。
- v1.2（2026-11-24）：多负责人。`assign` 接受 `names` 数组（与 `name` 可同时给，只动指定的人）；新增可选能力 `setAssignees`（整份名单替换）；`setAssignee` 退化为单人版兼容接口。数据格式未变——一个任务本来就允许多个 `@[[姓名]]`，此前只是实现与界面只放得下一个人。
- 宿主实现只承诺一个版本区间；未实现的可选能力要显式声明，而不是静默返回空结果。
