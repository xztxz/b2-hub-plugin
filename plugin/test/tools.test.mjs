import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { registerTools } from '../lib/tools.js'
import { normalizeSettings } from '../lib/settings.js'
import { createStore } from '../lib/store.js'

/** 用假的 ctx 收集工具定义，不依赖 DSH 运行时。 */
async function harness() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'b2hub-tools-'))
  const settings = normalizeSettings({ root: path.join(parent, 'B2') })
  const store = createStore(settings)
  const definitions = new Map()
  const ctx = {
    tools: {
      register(definition) {
        definitions.set(definition.name, definition)
      },
    },
  }
  registerTools(ctx, store, settings)
  return {
    definitions,
    store,
    root: settings.root,
    async cleanup() {
      await fs.rm(parent, { recursive: true, force: true })
    },
  }
}

test('注册的工具集合完整：读 + 写 + 中枢维护', async () => {
  const { definitions, cleanup } = await harness()
  try {
    const expected = [
      'b2_status', 'b2_list_notes', 'b2_read_note', 'b2_list_tasks',
      'b2_create_note', 'b2_write_note', 'b2_toggle_task', 'b2_set_due', 'b2_assign',
      'b2_overview', 'b2_list_people', 'b2_create_person', 'b2_sync_people',
      'b2_capture', 'b2_move_task', 'b2_set_status', 'b2_person_history', 'b2_init_library',
    ]
    assert.deepEqual([...definitions.keys()].sort(), expected.sort())
  } finally {
    await cleanup()
  }
})

test('每个工具都有描述、入参 schema、render 与 execute', async () => {
  const { definitions, cleanup } = await harness()
  try {
    for (const [name, definition] of definitions) {
      assert.equal(typeof definition.description, 'string', `${name} 缺 description`)
      assert.ok(definition.description.length >= 10, `${name} 的描述太短`)
      assert.equal(definition.parameters.type, 'object', `${name} 的 parameters 必须是 object`)
      assert.equal(typeof definition.execute, 'function', `${name} 缺 execute`)
      assert.equal(typeof definition.output.render, 'function', `${name} 缺 output.render`)
      assert.equal(definition.output.schema.type, 'object', `${name} 的 output.schema 必须是 object`)
    }
  } finally {
    await cleanup()
  }
})

test('b2_init_library → b2_capture → b2_move_task → b2_person_history 串起来可用', async () => {
  const { definitions, root, cleanup } = await harness()
  try {
    const init = await definitions.get('b2_init_library').execute({})
    assert.equal(init.fresh, true)
    assert.ok(init.created.length >= 4)

    await definitions.get('b2_create_person').execute({ name: '孙悟空', role: '打手' })
    const captured = await definitions.get('b2_capture').execute({ text: '取经计划 📅2026-12-24 @孙悟空' })
    assert.equal(captured.path, '00-Inbox/收件箱.md')
    assert.deepEqual(captured.assignees, ['孙悟空'])

    await definitions.get('b2_create_note').execute({ title: '西天取经', type: 'project' })
    const [task] = await definitions.get('b2_list_tasks').execute({ scope: 'inbox' }).then(value => value.tasks)
    const moved = await definitions.get('b2_move_task').execute({ path: task.path, line: task.line, target: '西天取经' })
    assert.equal(moved.moved, true)

    const history = await definitions.get('b2_person_history').execute({ name: '孙悟空' })
    assert.equal(history.name, '孙悟空')
    assert.equal(history.active.length, 1)
    assert.equal(history.active[0].project, '西天取经')

    const raw = await fs.readFile(path.join(root, '10-Projects/西天取经/西天取经.md'), 'utf8')
    assert.match(raw, /取经计划 📅2026-12-24 @\[\[孙悟空\]\]/)
  } finally {
    await cleanup()
  }
})

test('b2_set_status：只改项目笔记的 status，非项目笔记报错', async () => {
  const { definitions, cleanup } = await harness()
  try {
    await definitions.get('b2_init_library').execute({})
    const project = await definitions.get('b2_create_note').execute({ title: '归档试验', type: 'project' })
    const result = await definitions.get('b2_set_status').execute({ path: project.path, status: 'paused' })
    assert.equal(result.conflict, false)
    const note = await definitions.get('b2_read_note').execute({ path: project.path })
    assert.equal(note.frontmatter.status, 'paused')
    assert.equal(note.frontmatter.type, 'project')

    const inbox = await definitions.get('b2_capture').execute({ text: '一条随手记' })
    await assert.rejects(
      () => definitions.get('b2_set_status').execute({ path: inbox.path, status: 'done' }),
      /只有项目笔记/,
    )
    await assert.rejects(
      () => definitions.get('b2_set_status').execute({ path: project.path, status: '完成' }),
      /status 只能是/,
    )
  } finally {
    await cleanup()
  }
})

test('b2_assign：names 可以一次给多个负责人，也能只摘掉其中一个', async () => {
  const { definitions, cleanup } = await harness()
  try {
    await definitions.get('b2_init_library').execute({})
    await definitions.get('b2_create_person').execute({ name: '张三' })
    await definitions.get('b2_create_person').execute({ name: '李四' })
    const project = await definitions.get('b2_create_note').execute({
      title: '联调',
      type: 'project',
      body: '# 联调\n\n## 任务\n- [ ] 对接接口\n',
    })
    const note = await definitions.get('b2_read_note').execute({ path: project.path })
    const [task] = (await definitions.get('b2_list_tasks').execute({ scope: 'project' })).tasks
      .filter(item => item.path === project.path)

    const added = await definitions.get('b2_assign').execute({
      path: task.path,
      line: task.line,
      expect: note.hash,
      names: ['张三', '李四'],
    })
    assert.deepEqual(added.assignees, ['张三', '李四'])
    const shown = definitions.get('b2_assign').output.render({}, added)[0].text
    assert.match(shown, /当前指派（2）：@张三 @李四/)

    const afterAdd = await definitions.get('b2_read_note').execute({ path: task.path })
    const removed = await definitions.get('b2_assign').execute({
      path: task.path,
      line: task.line,
      expect: afterAdd.hash,
      name: '李四',
      action: 'remove',
    })
    assert.deepEqual(removed.assignees, ['张三'])

    // 既没给 name 也没给 names：报一句人话，而不是静默无操作
    await assert.rejects(
      () => definitions.get('b2_assign').execute({ path: task.path, line: task.line, expect: afterAdd.hash }),
      /需要 name 或 names/,
    )
  } finally {
    await cleanup()
  }
})

test('b2_status 在库缺失时给出「去哪修」的提示，而不是让人改 YAML', async () => {
  const { definitions, cleanup } = await harness()
  try {
    const status = await definitions.get('b2_status').execute({})
    assert.equal(status.exists, false)
    const rendered = definitions.get('b2_status').output.render({}, status)
    assert.match(rendered[0].text, /⚙ 设置/)
    assert.match(rendered[0].text, /b2_init_library/)
  } finally {
    await cleanup()
  }
})
