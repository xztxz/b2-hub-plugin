# B2 中枢（b2-hub）

把笔记与任务全部落在本地 Markdown 里的轻量中枢。当前形态是 **DSH 插件**：一组 `b2_*` 工具 + 一个侧栏面板。

库就是一个普通文件夹：

```
B2/
  00-Inbox/          快速落点
  10-Projects/       一个项目一个目录
  20-People/         人员笔记（type: person）
  90-Overview.md     汇总概览（生成物）
```

不绑定 Obsidian 应用，没有私有数据库或索引文件——只有 `.md`。界面上的每次创建、勾选、改期、指派、搬移都会立刻写进对应文件。

## 特性

- **文件是唯一真相源**：关掉插件，改动仍在文件里；在别的编辑器里改，面板刷新后同样看得到。
- **任务行约定**：`- [ ] 标题 📅2026-11-20 @[[张三]]`，兼容 Obsidian Tasks 的日期记法；一个任务可以有多个负责人。
- **冲突策略**：写前比对内容 hash，不一致按「最后写入赢」保存并返回 `conflict: true`。
- **零运行时依赖**：只用 Node 内置模块。
- **面板三视角**：待办 / 项目 / 人员；支持勾选、改期、改负责人、收件箱与项目互搬、新建项目、随手记、人员任务历史。

## 安装

见 [安装说明.md](安装说明.md)。简言之：把 `plugin/` 以绝对路径装进 DSH profile，在面板 ⚙ 里填写库根（支持 `~`、`%VAR%`、带引号路径）。

## 测试

```bash
cd plugin
node --test
```

51 条测试，覆盖路径解析、Markdown 解析、store 读写与冲突、工具 schema、HTTP 输入校验。

## 文档

| 文件 | 内容 |
|---|---|
| [DESIGN.md](DESIGN.md) | 设计：不变量、存储、接口表、路线 |
| [HOST-CONTRACT.md](HOST-CONTRACT.md) | 语言无关的宿主行为契约（v1.2） |
| [plugin/docs/DETAIL.md](plugin/docs/DETAIL.md) | 使用细节与约定 |

## 结构

```
plugin/
  index.js          DSH 宿主入口（注册工具 + 延迟挂 API）
  lib/settings.js   库根解析与默认值
  lib/markdown.js   frontmatter / 任务行 / 行号
  lib/store.js      全部读写逻辑
  lib/tools.js      18 个 b2_* 工具
  lib/api.js        POST /b2-hub/api（面板用）
  client.js         侧栏面板（React，单文件）
  test/             node --test
```
