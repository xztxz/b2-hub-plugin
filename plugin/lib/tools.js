/** 模型可见的工具：B2 中枢的读写入口。 */

import { dayDelta } from './markdown.js'

/** 输出结构按契约开放，避免每次加字段都要改 schema。 */
const OPEN_OUTPUT = { type: 'object', additionalProperties: true }

/** @param {string} text */
const text = text => [{ type: 'text', text }]
/** 工具返回值必须是无损 JSON：去掉 undefined。 */
const json = value => JSON.parse(JSON.stringify(value ?? null))

/** @param {string | undefined} due */
function dueLabel(due) {
  if (due === undefined) return '无截止日'
  const delta = dayDelta(due)
  if (delta < 0) return `⚠️已过期 ${Math.abs(delta)} 天（📅${due}）`
  if (delta === 0) return `📅今天（${due}）`
  if (delta <= 7) return `📅${delta} 天后（${due}）`
  return `📅${due}`
}

/** 冲突提示：写入成功，但检出别处的修改。 */
function conflictNotice(value) {
  return value.conflict
    ? `\n⚠️ 冲突：文件在读取后被别处修改过（原 hash ${String(value.previousHash).slice(0, 12)}）。已按「最后写入赢」保存，请复核这一处是否被覆盖。`
    : ''
}

/**
 * 注册 b2_* 工具。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {ReturnType<import('./settings.js').normalizeSettings>} settings
 */
export function registerTools(ctx, store, settings) {
  ctx.tools.register({
    name: 'b2_status',
    description: '报告 B2 中枢库是否可用：库根路径、是否存在、笔记数与未完成任务数。笔记操作失败或结果异常时先调用它。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: OPEN_OUTPUT,
      render: (_args, value) => {
        if (!value.exists) {
          return text(`B2 库不存在：${value.root}\n两种修法：① 面板页头 ⚙ 设置 → 填已有库路径并保存；② 想新建库就点「初始化此库」（或调用 b2_init_library）。`)
        }
        return text(`B2 库：${value.root}\n笔记 ${value.notes} 篇，未完成任务 ${value.openTasks} 个。`)
      },
    },
    async execute() {
      try {
        const notes = await store.listNotes()
        const tasks = await store.listTasks()
        return json({ root: store.root, exists: true, notes: notes.length, openTasks: tasks.length })
      } catch (error) {
        return json({ root: store.root, exists: false, notes: 0, openTasks: 0, reason: String(error?.message ?? error) })
      }
    },
  })

  ctx.tools.register({
    name: 'b2_list_notes',
    description: '列出 B2 库里的笔记元信息（不返回正文）：路径、类型、标题、状态、截止日、更新时间。可按类型过滤或用关键词匹配路径与标题。',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: '笔记类型：project / person / note；省略表示全部' },
        query: { type: 'string', description: '关键词，大小写不敏感，匹配库内路径与标题' },
      },
      additionalProperties: false,
    },
    output: {
      schema: OPEN_OUTPUT,
      render: (_args, value) => {
        if (value.notes.length === 0) return text('没有匹配的笔记。')
        const rows = value.notes.map(note => {
          const extra = [note.type, note.status, note.due === undefined ? '' : `📅${note.due}`].filter(part => part !== undefined && part !== '').join(' · ')
          return `- ${note.title}（${extra}）— ${note.path}`
        })
        return text(`${value.notes.length} 篇笔记：\n${rows.join('\n')}`)
      },
    },
    async execute(args) {
      const notes = await store.listNotes({ type: args.type, query: args.query })
      return json({ notes })
    },
  })

  ctx.tools.register({
    name: 'b2_read_note',
    description: '按库内相对路径读取一篇 B2 笔记，返回 frontmatter、正文和内容 hash（写操作时作为 expect 冲突检测依据）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '库内相对路径，例如 10-Projects/示例/示例.md' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: OPEN_OUTPUT,
      render: (_args, value) => {
        const meta = Object.entries(value.frontmatter).map(([key, item]) => `${key}: ${Array.isArray(item) ? item.join(', ') : String(item)}`)
        const header = [
          `# ${value.path}`,
          `${value.size} B · hash ${value.hash.slice(0, 12)} · ${value.updated}`,
          '',
          '## frontmatter',
          meta.length === 0 ? '（无）' : meta.join('\n'),
          '',
          '## 正文',
        ]
        return text([...header, value.body].join('\n'))
      },
    },
    async execute(args) {
      return json(await store.readNote(args.path))
    },
  })

  ctx.tools.register({
    name: 'b2_list_tasks',
    description: '列出 B2 库里的 checkbox 任务，按截止日排序（无截止日排最后）。默认只返回未完成；可按 scope（全部/项目/收件箱）和 @指派 过滤。返回的 line 是整文件行号，可直接用于 b2_toggle_task / b2_set_due / b2_assign。',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'all（默认）/ project（10-Projects 下）/ inbox（00-Inbox 下）', enum: ['all', 'project', 'inbox'] },
        assignee: { type: 'string', description: '只返回指派给此人的任务，与任务行里的 @姓名 一致' },
        includeDone: { type: 'boolean', description: '是否包含已完成任务，默认 false' },
      },
      additionalProperties: false,
    },
    output: {
      schema: OPEN_OUTPUT,
      render: (_args, value) => {
        if (value.tasks.length === 0) return text('没有匹配的任务。')
        const rows = value.tasks.map((task, index) => {
          const assignees = task.assignees.length === 0 ? '' : ` @${task.assignees.join(' @')}`
          const effort = task.effort === undefined ? '' : ` · ${task.effort}h`
          const title = task.done ? `~~${task.title}~~` : task.title
          return `${index + 1}. ${dueLabel(task.due)} · ${title}${assignees}${effort} — ${task.path}:${task.line}`
        })
        return text(`${value.tasks.length} 个任务（按截止日排序）：\n${rows.join('\n')}`)
      },
    },
    async execute(args) {
      const tasks = await store.listTasks({ scope: args.scope, assignee: args.assignee, includeDone: args.includeDone })
      return json({ tasks })
    },
  })

  ctx.tools.register({
    name: 'b2_create_note',
    description: '在 B2 库里新建一篇笔记。省略 folder 时按类型落位：project → 10-Projects/<标题>/<标题>.md，person → 20-People，note → 00-Inbox。同名文件已存在时报错，绝不覆盖。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '笔记标题，同时作为文件名' },
        type: { type: 'string', description: 'project / person / note，默认 note', enum: ['project', 'person', 'note'] },
        folder: { type: 'string', description: '目标目录（库内相对路径）；省略则按类型落位' },
        body: { type: 'string', description: '正文，省略则只写一个一级标题' },
        frontmatter: { type: 'object', additionalProperties: true, description: '附加 frontmatter 字段，与默认字段合并' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    output: {
      schema: OPEN_OUTPUT,
      render: (_args, value) => text(`已创建：${value.path}\nhash ${value.hash.slice(0, 12)}`),
    },
    async execute(args) {
      return json(await store.createNote(args))
    },
  })

  ctx.tools.register({
    name: 'b2_write_note',
    description: '写入一篇已存在的 B2 笔记（原子写）。必须带上读取时得到的 expect hash；若文件已被别处修改，按「最后写入赢」保存并在结果里标记 conflict。frontmatter / body 省略时保留原值。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '库内相对路径' },
        expect: { type: 'string', description: '读取该笔记时的 hash（b2_read_note 返回，可只传前 12 位）' },
        frontmatter: { type: 'object', additionalProperties: true, description: '要合并进 frontmatter 的字段' },
        body: { type: 'string', description: '新的完整正文；省略表示保留原正文' },
      },
      required: ['path', 'expect'],
      additionalProperties: false,
    },
    output: {
      schema: OPEN_OUTPUT,
      render: (_args, value) => text(`已写入：${value.path}\nhash ${value.hash.slice(0, 12)}${conflictNotice(value)}`),
    },
    async execute(args) {
      return json(await store.writeNote(args))
    },
  })

  ctx.tools.register({
    name: 'b2_toggle_task',
    description: '勾选或取消勾选一篇笔记里的一行 checkbox 任务。line 用 b2_list_tasks 返回的整文件行号。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '库内相对路径' },
        line: { type: 'integer', description: '整文件行号（b2_list_tasks 的 line）' },
        expect: { type: 'string', description: '读取该笔记时的 hash' },
        done: { type: 'boolean', description: '目标状态；省略表示切换当前状态' },
      },
      required: ['path', 'line', 'expect'],
      additionalProperties: false,
    },
    output: {
      schema: OPEN_OUTPUT,
      render: (_args, value) => text(`已${value.done ? '标记完成' : '取消完成'}：${value.path}:${value.line}${conflictNotice(value)}`),
    },
    async execute(args) {
      const result = await store.toggleTask(args)
      return json({ ...result, line: args.line })
    },
  })

  ctx.tools.register({
    name: 'b2_set_due',
    description: '设置或清除一行任务的截止日（📅YYYY-MM-DD）。line 用 b2_list_tasks 返回的整文件行号；due 省略或传空字符串表示清除。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '库内相对路径' },
        line: { type: 'integer', description: '整文件行号' },
        expect: { type: 'string', description: '读取该笔记时的 hash' },
        due: { type: 'string', description: 'YYYY-MM-DD；省略或空字符串表示清除截止日' },
      },
      required: ['path', 'line', 'expect'],
      additionalProperties: false,
    },
    output: {
      schema: OPEN_OUTPUT,
      render: (_args, value) => text(`${value.due === undefined ? '已清除截止日' : `截止日设为 📅${value.due}`}：${value.path}:${value.line}${conflictNotice(value)}`),
    },
    async execute(args) {
      const result = await store.setDue(args)
      return json({ ...result, line: args.line })
    },
  })

  ctx.tools.register({
    name: 'b2_assign',
    description: '给一行任务增删 @姓名 指派（幂等）。一个任务可以有多个负责人：name 给一个，names 给多个（两个都给会合并去重）。line 用 b2_list_tasks 返回的整文件行号；action 默认 add。姓名必须对应 20-People 下已存在的人员笔记；指派写成 `@[[姓名]]` 双链，同时同步每个人的人员笔记任务清单。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '库内相对路径' },
        line: { type: 'integer', description: '整文件行号' },
        expect: { type: 'string', description: '读取该笔记时的 hash' },
        name: { type: 'string', description: '单个负责人姓名，与人员笔记同名，不含空格（与 names 二选一，可同时给）' },
        names: { type: 'array', items: { type: 'string' }, description: '多个负责人姓名；一个任务需要多人负责时用它' },
        action: { type: 'string', description: 'add（默认）或 remove', enum: ['add', 'remove'] },
      },
      required: ['path', 'line', 'expect'],
      additionalProperties: false,
    },
    output: {
      schema: OPEN_OUTPUT,
      render: (_args, value) => {
        const who = value.assignees.length === 0 ? '（无人）' : `@${value.assignees.join(' @')}`
        const targets = value.names.length === 0 ? '' : ` ${value.names.join('、')}`
        return text(`${value.action === 'remove' ? '已移除' : '已指派'}${targets}：${value.path}:${value.line}\n当前指派（${value.assignees.length}）：${who}${conflictNotice(value)}`)
      },
    },
    async execute(args) {
      const names = [...(Array.isArray(args.names) ? args.names : []), ...(typeof args.name === 'string' ? [args.name] : [])]
      if (names.filter(name => String(name ?? '').trim() !== '').length === 0) {
        throw new Error('需要 name 或 names：至少指定一名负责人')
      }
      const result = await store.assign({ ...args, names })
      return json({ ...result, line: args.line })
    },
  })

  ctx.tools.register({
    name: 'b2_list_people',
    description: '列出 B2 库里的人员：姓名、角色、在手任务数、逾期数，以及名下的任务。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: OPEN_OUTPUT,
      render: (_args, value) => {
        if (value.people.length === 0) {
          return text('还没有人员笔记。用 b2_create_person 建人，或在 20-People 下写一篇 type: person 的笔记。')
        }
        const rows = value.people.map(person => {
          const role = person.role === undefined ? '' : `（${person.role}）`
          const overdue = person.overdue === 0 ? '' : ` · 逾期 ${person.overdue}`
          return `- ${person.name}${role} · ${person.open} 个任务${overdue} — ${person.path}`
        })
        return text(`${value.people.length} 个人：\n${rows.join('\n')}`)
      },
    },
    async execute() {
      return json({ people: await store.listPeople() })
    },
  })

  ctx.tools.register({
    name: 'b2_create_person',
    description: '在 20-People 下新建一篇人员笔记（type: person）。同名已存在时报错，不覆盖。给任务加 @姓名 前先用它建人，否则 b2_assign 会拒绝。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '姓名，同时作为文件名；不含空格、@、#' },
        role: { type: 'string', description: '角色，例如 开发 / 设计 / 产品；可省略' },
        body: { type: 'string', description: '正文，省略则只写一级标题' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      schema: OPEN_OUTPUT,
      render: (_args, value) => text(`已创建人员：${value.path}${value.role === undefined ? '' : `（${value.role}）`}`),
    },
    async execute(args) {
      return json(await store.createPerson(args))
    },
  })

  ctx.tools.register({
    name: 'b2_sync_people',
    description: '重新生成人员笔记里的「## 任务」清单（双链指回任务所在笔记）。指派、随手记、勾选、改期、搬移时会自动同步相关的人；这个工具用于全量刷新。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: OPEN_OUTPUT,
      render: (_args, value) => value.people.length === 0
        ? text('没有人员笔记。')
        : text(value.people.map(person => `- ${person.name}：${person.tasks} 个任务${person.changed ? '（已更新）' : ''}`).join('\n')),
    },
    async execute() {
      return json({ people: await store.syncPeople() })
    },
  })

  ctx.tools.register({
    name: 'b2_overview',
    description: '重新生成 90-Overview.md：项目一览、逾期任务、本周任务、未指派任务。这是生成物，会整体覆盖该文件；不要手工编辑它。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: OPEN_OUTPUT,
      render: (_args, value) => text(`已生成 ${value.path}（${value.projects} 个项目，hash ${value.hash.slice(0, 12)}）`),
    },
    async execute() {
      return json(await store.writeOverview())
    },
  })

  ctx.tools.register({
    name: 'b2_capture',
    description: '随手记：把一句话作为任务行追加到收件箱（或指定项目）的「## 任务」下，立刻落盘。文字里可以直接写 📅2026-11-20 和 @姓名，会被识别成截止日与指派。收件箱笔记不存在时会自动创建。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记的内容；可含 📅YYYY-MM-DD 与 @姓名' },
        target: { type: 'string', description: '目标：省略或 inbox 表示收件箱；也可以填项目名' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: OPEN_OUTPUT,
      render: (_args, value) => {
        const who = value.assignees.length === 0 ? '' : `（已指派 @${value.assignees.join(' @')}）`
        return text(`已记入 ${value.path}${value.created ? '（新建了收件箱）' : ''}：${value.text}${who}`)
      },
    },
    async execute(args) {
      return json(await store.capture(args.text, args.target))
    },
  })

  ctx.tools.register({
    name: 'b2_move_task',
    description: '把一行任务整行搬到另一篇笔记的「## 任务」下（截止日、指派、勾选状态原样保留）。target 省略或传 inbox 表示搬到收件箱，填项目名则搬进该项目。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '任务当前所在笔记的库内相对路径' },
        line: { type: 'integer', description: '整文件行号（b2_list_tasks 的 line）' },
        target: { type: 'string', description: '目标：项目名，或 inbox（收件箱）' },
      },
      required: ['path', 'line', 'target'],
      additionalProperties: false,
    },
    output: {
      schema: OPEN_OUTPUT,
      render: (_args, value) => value.moved
        ? text(`已搬移：${value.from}:${_args.line} → ${value.path}\n任务：${value.title}`)
        : text(`没有搬移：${value.reason ?? '已在目标笔记里'}`),
    },
    async execute(args) {
      const result = await store.moveTask(args.path, args.line, args.target)
      return json({ ...result, line: args.line })
    },
  })

  ctx.tools.register({
    name: 'b2_set_status',
    description: '设置项目笔记的状态（frontmatter.status）：active 进行中 / paused 已暂停 / blocked 受阻 / done 已完成。只对 type: project 的笔记有效，立刻落盘，面板与概览随之变化。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '项目笔记的库内相对路径' },
        status: { type: 'string', description: 'active / paused / blocked / done', enum: ['active', 'paused', 'blocked', 'done'] },
        expect: { type: 'string', description: '省略时自动用当前 hash；显式传入则按它做冲突检测' },
      },
      required: ['path', 'status'],
      additionalProperties: false,
    },
    output: {
      schema: OPEN_OUTPUT,
      render: (_args, value) => text(`已设为 ${value.status}：${value.path}${conflictNotice(value)}`),
    },
    async execute(args) {
      const status = String(args.status ?? '').trim()
      const allowed = ['active', 'paused', 'blocked', 'done']
      if (!allowed.includes(status)) throw new Error(`status 只能是 ${allowed.join(' / ')}：${status}`)
      const note = await store.readNote(args.path)
      if (note.frontmatter.type !== 'project') throw new Error(`只有项目笔记能设状态（type: project）：${args.path}`)
      const expect = typeof args.expect === 'string' && args.expect !== '' ? args.expect : note.hash
      const result = await store.writeNote({ path: args.path, expect, frontmatter: { status } })
      return json({ ...result, path: args.path, status })
    },
  })

  ctx.tools.register({
    name: 'b2_person_history',
    description: '看某个人的完整任务历史：进行中与已完成分开列出，每条标注所属项目与截止日。用于交接、复盘或问「张三手上还有什么」。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '人员姓名，与 20-People 下的笔记同名' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      schema: OPEN_OUTPUT,
      render: (_args, value) => {
        const line = task => {
          const due = task.due === undefined ? '' : ` 📅${task.due}`
          const project = task.project === undefined ? '' : `（${task.project}）`
          return `- ${task.title}${due}${project} — ${task.path}:${task.line}`
        }
        const role = value.role === undefined ? '' : ` · ${value.role}`
        return text([
          `${value.name}${role}：进行中 ${value.active.length} 个，已完成 ${value.done.length} 个`,
          '',
          '## 进行中',
          ...(value.active.length === 0 ? ['（无）'] : value.active.map(line)),
          '',
          '## 已完成',
          ...(value.done.length === 0 ? ['（无）'] : value.done.map(line)),
        ].join('\n'))
      },
    },
    async execute(args) {
      return json(await store.personHistory(args.name))
    },
  })

  ctx.tools.register({
    name: 'b2_init_library',
    description: '初始化 B2 库：建 00-Inbox / 10-Projects / 20-People / 90-Overview.md；只有库根原本不存在（新库）时，才额外放 1 个示例项目 + 1 个示例人员。永不覆盖已有文件，重复调用幂等。会创建目录，只在用户明确要建库时调用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: OPEN_OUTPUT,
      render: (_args, value) => value.fresh
        ? text(`已新建库：${value.root}\n创建了：${value.created.join('、')}`)
        : text(`库已存在：${value.root}\n补全了：${value.created.length === 0 ? '（无缺失项）' : value.created.join('、')}`),
    },
    async execute() {
      return json(await store.initLibrary())
    },
  })
}
