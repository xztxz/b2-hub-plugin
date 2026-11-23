import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { normalizeSettings, DEFAULTS } from '../lib/settings.js'
import { createStore } from '../lib/store.js'

/** 每个用例一个临时库；root 故意先不存在，用来验证「不自动建库」。 */
async function setup() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'b2hub-test-'))
  const root = path.join(parent, 'B2')
  const settings = normalizeSettings({ root })
  const store = createStore(settings)
  return {
    store,
    root,
    settings,
    async cleanup() {
      await fs.rm(parent, { recursive: true, force: true })
    },
  }
}

const read = (root, relative) => fs.readFile(path.join(root, relative), 'utf8')

test('库不存在时读操作报 ROOT_MISSING，且不会顺手建目录', async () => {
  const { store, root, cleanup } = await setup()
  try {
    await assert.rejects(() => store.listNotes(), error => error.code === 'ROOT_MISSING')
    await assert.rejects(() => store.listTasks(), error => error.code === 'ROOT_MISSING')
    await assert.rejects(() => store.capture('随便记一句'), error => error.code === 'ROOT_MISSING')
    await assert.rejects(() => fs.stat(root), error => error.code === 'ENOENT')
  } finally {
    await cleanup()
  }
})

test('initLibrary：新库建四件套 + 各一个示例，重复调用幂等', async () => {
  const { store, root, cleanup } = await setup()
  try {
    const first = await store.initLibrary()
    assert.equal(first.fresh, true)
    for (const folder of ['00-Inbox', '10-Projects', '20-People']) {
      const stat = await fs.stat(path.join(root, folder))
      assert.ok(stat.isDirectory(), `${folder} 应当是目录`)
    }
    assert.ok((await fs.stat(path.join(root, '90-Overview.md'))).isFile())
    assert.ok((await fs.stat(path.join(root, '10-Projects/示例项目/示例项目.md'))).isFile())
    assert.ok((await fs.stat(path.join(root, '20-People/示例成员.md'))).isFile())

    const second = await store.initLibrary()
    assert.equal(second.fresh, false)
    assert.deepEqual(second.created, [])
    const notes = await store.listNotes()
    assert.equal(notes.length, 3)
  } finally {
    await cleanup()
  }
})

test('initLibrary：已有内容的库只补缺失项，不加示例、不覆盖文件', async () => {
  const { store, root, cleanup } = await setup()
  try {
    await fs.mkdir(path.join(root, '00-Inbox'), { recursive: true })
    const mine = '---\ntype: note\n---\n\n# 我自己写的\n'
    await fs.writeFile(path.join(root, '00-Inbox/我的笔记.md'), mine, 'utf8')

    const result = await store.initLibrary()
    assert.equal(result.fresh, false)
    assert.deepEqual(result.created.sort(), ['10-Projects', '20-People', '90-Overview.md'].sort())
    assert.equal(await read(root, '00-Inbox/我的笔记.md'), mine)
    await assert.rejects(() => fs.stat(path.join(root, '10-Projects/示例项目/示例项目.md')), error => error.code === 'ENOENT')
  } finally {
    await cleanup()
  }
})

test('createNote：按类型落位，同名不覆盖', async () => {
  const { store, root, cleanup } = await setup()
  try {
    await store.initLibrary()
    const project = await store.createNote({ title: '网站改版', type: 'project' })
    assert.equal(project.path, '10-Projects/网站改版/网站改版.md')
    const content = await read(root, project.path)
    assert.match(content, /type: project/)
    assert.match(content, /status: active/)
    assert.match(content, /# 网站改版/)

    await assert.rejects(
      () => store.createNote({ title: '网站改版', type: 'project' }),
      error => error.code === 'ALREADY_EXISTS',
    )
    // 原文件一个字都没被改
    assert.equal(await read(root, project.path), content)
  } finally {
    await cleanup()
  }
})

test('路径必须留在库内：../ 与绝对路径都被拒', async () => {
  const { store, cleanup } = await setup()
  try {
    await store.initLibrary()
    await assert.rejects(() => store.readNote('../外面.md'), error => error.code === 'OUTSIDE_ROOT')
    await assert.rejects(() => store.readNote('C:/Windows/win.ini'), error => error.code === 'OUTSIDE_ROOT')
  } finally {
    await cleanup()
  }
})

test('勾选 / 改期 / 指派：都落盘到同一行，指派要求人已存在', async () => {
  const { store, root, cleanup } = await setup()
  try {
    await store.initLibrary()
    const project = await store.createNote({
      title: '发布',
      type: 'project',
      body: '# 发布\n\n## 任务\n- [ ] 写公告\n',
    })
    const [before] = await store.listTasks({ scope: 'project' }).then(tasks => tasks.filter(task => task.path === project.path))
    assert.ok(before.line > 1, '任务行号应当计入 frontmatter')
    const hash = (await store.readNote(project.path)).hash

    const toggled = await store.toggleTask({ path: project.path, line: before.line, expect: hash, done: true })
    assert.equal(toggled.done, true)
    assert.equal(toggled.conflict, false)
    assert.match(await read(root, project.path), /- \[x\] 写公告/)

    const afterToggle = (await store.readNote(project.path)).hash
    const due = await store.setDue({ path: project.path, line: before.line, expect: afterToggle, due: '2026-12-01' })
    assert.equal(due.due, '2026-12-01')
    assert.match(await read(root, project.path), /📅2026-12-01/)

    const afterDue = (await store.readNote(project.path)).hash
    await assert.rejects(
      () => store.assign({ path: project.path, line: before.line, expect: afterDue, name: '不存在的人' }),
      error => error.code === 'NOT_FOUND',
    )

    await store.createPerson({ name: '张三', role: '开发' })
    const assigned = await store.assign({ path: project.path, line: before.line, expect: afterDue, name: '张三' })
    assert.deepEqual(assigned.assignees, ['张三'])
    assert.match(await read(root, project.path), /@\[\[张三\]\]/)

    const person = await read(root, '20-People/张三.md')
    assert.match(person, /## 任务/)
    assert.match(person, /\[\[发布\]\]/)

    const hashNow = (await store.readNote(project.path)).hash
    const removed = await store.assign({ path: project.path, line: before.line, expect: hashNow, name: '张三', action: 'remove' })
    assert.deepEqual(removed.assignees, [])
    assert.ok(!(await read(root, project.path)).includes('@[[张三]]'))
  } finally {
    await cleanup()
  }
})

test('多人负责：一个任务可以指派给多个人，增删幂等、人员清单各自同步', async () => {
  const { store, root, cleanup } = await setup()
  try {
    await store.initLibrary()
    await store.createPerson({ name: '张三' })
    await store.createPerson({ name: '李四' })
    const project = await store.createNote({
      title: '联调',
      type: 'project',
      body: '# 联调\n\n## 任务\n- [ ] 对接接口\n',
    })
    const [task] = await store.listTasks({ scope: 'project' }).then(tasks => tasks.filter(item => item.path === project.path))
    const hash0 = (await store.readNote(project.path)).hash

    const added = await store.assign({ path: project.path, line: task.line, expect: hash0, names: ['张三', '李四'] })
    assert.deepEqual(added.assignees, ['张三', '李四'])
    assert.deepEqual(added.names, ['张三', '李四'])
    assert.match(await read(root, project.path), /@\[\[张三\]\] @\[\[李四\]\]/)
    // 两个人都能在自己的人员笔记里看到这条任务
    assert.match(await read(root, '20-People/张三.md'), /\[\[联调\]\]/)
    assert.match(await read(root, '20-People/李四.md'), /\[\[联调\]\]/)

    // 幂等：同一个人再加一次，文件一个字都不动
    const hash1 = (await store.readNote(project.path)).hash
    const again = await store.assign({ path: project.path, line: task.line, expect: hash1, names: ['张三'] })
    assert.deepEqual(again.assignees, ['张三', '李四'])
    assert.equal(again.hash, hash1)

    // 只移除一个人，另一个留着
    const removed = await store.assign({ path: project.path, line: task.line, expect: hash1, names: ['张三'], action: 'remove' })
    assert.deepEqual(removed.assignees, ['李四'])
    assert.ok(!(await read(root, '20-People/张三.md')).includes('[[联调]]'))
    assert.match(await read(root, '20-People/李四.md'), /\[\[联调\]\]/)
    assert.equal((await store.listTasks({ assignee: '李四' })).length, 1)
    assert.equal((await store.listTasks({ assignee: '张三' })).length, 0)

    // 面板用的「整份名单」接口：按给定顺序重写
    const hash2 = (await store.readNote(project.path)).hash
    const replaced = await store.setAssignees({ path: project.path, line: task.line, expect: hash2, names: ['张三', '李四'] })
    assert.deepEqual(replaced.assignees, ['张三', '李四'])
    assert.match(await read(root, project.path), /- \[ \] 对接接口 @\[\[张三\]\] @\[\[李四\]\]/)

    // 不存在的人：一次把缺的都报出来
    const hash3 = (await store.readNote(project.path)).hash
    await assert.rejects(
      () => store.setAssignees({ path: project.path, line: task.line, expect: hash3, names: ['王五', '赵六'] }),
      error => error.code === 'NOT_FOUND' && /王五、赵六/.test(error.message),
    )
  } finally {
    await cleanup()
  }
})

test('冲突策略：expect 过期时最后写入赢，并返回 conflict: true', async () => {
  const { store, root, cleanup } = await setup()
  try {
    await store.initLibrary()
    const note = await store.createNote({ title: '冲突', type: 'note', body: '# 冲突\n\n原内容\n' })
    const stale = (await store.readNote(note.path)).hash

    // 模拟别处（Obsidian）改了文件
    const theirs = '---\ntype: note\n---\n\n# 冲突\n\n别人改的\n'
    await fs.writeFile(path.join(root, note.path), theirs, 'utf8')

    const result = await store.writeNote({ path: note.path, expect: stale, body: '# 冲突\n\n我改的\n' })
    assert.equal(result.conflict, true)
    assert.match(await read(root, note.path), /我改的/)
    // previousHash 指向「被覆盖的那一版」，方便宿主告诉用户丢了什么
    assert.notEqual(result.previousHash, stale)
    assert.equal(result.previousHash, createHash('sha256').update(theirs, 'utf8').digest('hex'))
  } finally {
    await cleanup()
  }
})

test('hash 前缀也能当 expect 用（面板只显示前 12 位）', async () => {
  const { store, root, cleanup } = await setup()
  try {
    await store.initLibrary()
    const note = await store.createNote({ title: '前缀', type: 'note' })
    const full = (await store.readNote(note.path)).hash
    const result = await store.writeNote({ path: note.path, expect: full.slice(0, 12), body: '# 前缀\n\n新正文\n' })
    assert.equal(result.conflict, false)
    assert.match(await read(root, note.path), /新正文/)
  } finally {
    await cleanup()
  }
})

test('capture：随手记进收件箱，自动建笔记并把 📅 / @姓名 解析出来', async () => {
  const { store, root, cleanup } = await setup()
  try {
    await store.initLibrary()
    await store.createPerson({ name: '李四' })
    const result = await store.capture('打电话给客户 📅2026-11-25 @李四')
    assert.equal(result.created, true)
    assert.equal(result.path, '00-Inbox/收件箱.md')
    assert.deepEqual(result.assignees, ['李四'])
    const content = await read(root, '00-Inbox/收件箱.md')
    assert.match(content, /## 任务/)
    // 已知人员的纯文本 @姓名 会升级成 Obsidian 双链，反向链接才建得起来
    assert.match(content, /打电话给客户 📅2026-11-25 @\[\[李四\]\]/)

    const again = await store.capture('第二件事')
    assert.equal(again.created, false)
    assert.equal((await read(root, '00-Inbox/收件箱.md')).match(/^- \[ \]/gm).length, 2)
  } finally {
    await cleanup()
  }
})

test('moveTask：整行搬进项目，原笔记不再有它', async () => {
  const { store, root, cleanup } = await setup()
  try {
    await store.initLibrary()
    await store.createNote({ title: '旧城改造', type: 'project' })
    await store.createPerson({ name: '王五' })
    await store.capture('搬我一下 📅2026-11-30 @王五')
    const [task] = await store.listTasks({ scope: 'inbox' })

    const moved = await store.moveTask(task.path, task.line, '旧城改造')
    assert.equal(moved.moved, true)
    assert.equal(moved.path, '10-Projects/旧城改造/旧城改造.md')
    assert.match(await read(root, moved.path), /搬我一下 📅2026-11-30 @\[\[王五\]\]/)
    assert.ok(!(await read(root, '00-Inbox/收件箱.md')).includes('搬我一下'))

    const again = await store.moveTask(`10-Projects/旧城改造/旧城改造.md`, 1, '旧城改造')
    assert.equal(again.moved, false)
  } finally {
    await cleanup()
  }
})

test('writeOverview：生成物覆盖旧文件，含项目 / 逾期 / 本周 / 未指派四段', async () => {
  const { store, root, cleanup } = await setup()
  try {
    await store.initLibrary()
    const project = await store.createNote({
      title: '周会',
      type: 'project',
      body: '# 周会\n\n## 任务\n- [ ] 定会议室 📅2026-01-01\n- [ ] 没日期的活\n',
    })
    const result = await store.writeOverview()
    assert.equal(result.path, '90-Overview.md')
    const overview = await read(root, '90-Overview.md')
    for (const heading of ['## 项目', '## 逾期', '## 本周', '## 未指派']) {
      assert.ok(overview.includes(heading), `概览缺少 ${heading}`)
    }
    assert.ok(overview.includes('定会议室'))
    assert.ok(overview.includes(project.path))
  } finally {
    await cleanup()
  }
})

test('personHistory：进行中与已完成分开，并标注所属项目', async () => {
  const { store, root, cleanup } = await setup()
  try {
    await store.initLibrary()
    await store.createPerson({ name: '赵六', role: '设计' })
    const project = await store.createNote({
      title: '改版',
      type: 'project',
      body: '# 改版\n\n## 任务\n- [ ] 出视觉稿 @[[赵六]]\n- [x] 收集参考 @[[赵六]]\n',
    })
    const history = await store.personHistory('赵六')
    assert.equal(history.name, '赵六')
    assert.equal(history.role, '设计')
    assert.equal(history.active.length, 1)
    assert.equal(history.done.length, 1)
    assert.equal(history.active[0].project, '改版')
    assert.equal(history.active[0].path, project.path)
  } finally {
    await cleanup()
  }
})

test('listNotes / listTasks：按类型、关键词过滤，按截止日排序', async () => {
  const { store, cleanup } = await setup()
  try {
    await store.initLibrary()
    await store.createNote({ title: '有日期', type: 'project', body: '# 有日期\n\n## 任务\n- [ ] 晚 📅2026-12-31\n- [ ] 早 📅2026-11-20\n- [ ] 无日期\n' })
    const notes = await store.listNotes({ type: 'project' })
    assert.deepEqual(notes.map(note => note.title), ['有日期', '示例项目'].sort((a, b) => a.localeCompare(b, 'zh')))

    const byQuery = await store.listNotes({ query: '有日期' })
    assert.equal(byQuery.length, 1)

    const tasks = await store.listTasks({ scope: 'project' })
    const titles = tasks.filter(task => task.path === '10-Projects/有日期/有日期.md').map(task => task.title)
    assert.deepEqual(titles, ['早', '晚', '无日期'])
  } finally {
    await cleanup()
  }
})

test('写出的文件是 UTF-8 无 BOM、LF 换行（Obsidian 直接打开即可）', async () => {
  const { store, root, cleanup } = await setup()
  try {
    await store.initLibrary()
    const note = await store.createNote({ title: '编码', type: 'note', body: '# 编码\n\n中文内容\n' })
    for (const relative of [note.path, '90-Overview.md', '20-People/示例成员.md']) {
      const buffer = await fs.readFile(path.join(root, relative))
      assert.notEqual(buffer[0], 0xEF, `${relative} 不应有 BOM`)
      const text = buffer.toString('utf8')
      assert.ok(!text.includes('\r'), `${relative} 不应用 CRLF`)
    }
    assert.equal(DEFAULTS.excluded.includes('.obsidian'), true)
  } finally {
    await cleanup()
  }
})
