import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { registerApi } from '../lib/api.js'
import { normalizeSettings } from '../lib/settings.js'
import { createStore } from '../lib/store.js'

/** 用假的 webServer + http req/res 驱动真实的端点处理函数。 */
async function harness() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'b2hub-api-'))
  const root = path.join(parent, 'B2')
  const settings = normalizeSettings({ root })
  const store = createStore(settings)
  const saved = []
  let handler
  const ctx = {
    webServer: {
      register(definition) {
        handler = definition.handler
        return () => {}
      },
    },
  }
  registerApi(ctx, store, async patch => {
    saved.push(patch)
  }, settings)

  async function call(op, args = {}) {
    const body = JSON.stringify({ op, args })
    const req = Readable.from([Buffer.from(body, 'utf8')])
    req.method = 'POST'
    req.headers = { 'content-type': 'application/json', host: '127.0.0.1:1' }
    const res = {
      status: 0,
      headers: {},
      writeHead(status, headers) {
        this.status = status
        Object.assign(this.headers, headers)
      },
      end(payload) {
        this.payload = payload
      },
    }
    await handler(req, res)
    return { status: res.status, ...JSON.parse(res.payload) }
  }

  return {
    call,
    saved,
    store,
    root,
    parent,
    async cleanup() {
      await fs.rm(parent, { recursive: true, force: true })
    },
  }
}

test('saveRoot：人话路径会被展开成绝对路径再落配置', async () => {
  const { call, saved, cleanup } = await harness()
  try {
    const result = await call('saveRoot', { root: '~/vault/B2' })
    assert.equal(result.ok, true)
    assert.equal(result.value.root, path.join(os.homedir(), 'vault', 'B2'))
    assert.equal(result.value.exists, false)
    assert.match(result.value.note, /初始化此库/)
    assert.deepEqual(saved.at(-1), { root: path.join(os.homedir(), 'vault', 'B2') })
  } finally {
    await cleanup()
  }
})

test('saveRoot：空路径与「路径是文件」都被拒绝，且不写配置', async () => {
  const { call, saved, root, parent, cleanup } = await harness()
  try {
    const empty = await call('saveRoot', { root: '   ' })
    assert.equal(empty.ok, false)
    assert.match(empty.error, /不能为空/)

    const file = path.join(parent, 'note.md')
    await fs.writeFile(file, '# x\n', 'utf8')
    const asFile = await call('saveRoot', { root: file })
    assert.equal(asFile.ok, false)
    assert.match(asFile.error, /是文件，不是目录/)

    assert.deepEqual(saved, [])
    assert.equal(root, path.join(parent, 'B2'))
  } finally {
    await cleanup()
  }
})

test('saveRoot：目录已存在时提示「路径已保存」而不是叫人去初始化', async () => {
  const { call, root, cleanup } = await harness()
  try {
    await fs.mkdir(root, { recursive: true })
    const result = await call('saveRoot', { root: root.replace(/\\/g, '/') })
    assert.equal(result.ok, true)
    assert.equal(result.value.exists, true)
    assert.match(result.value.note, /正在重启/)
  } finally {
    await cleanup()
  }
})

test('saveRoot：相对路径被拒绝（它依赖 cwd，换个宿主就指向别处）', async () => {
  const { call, saved, cleanup } = await harness()
  try {
    const result = await call('saveRoot', { root: 'relative/B2' })
    assert.equal(result.ok, false)
    assert.match(result.error, /需要绝对路径/)
    assert.deepEqual(saved, [])
  } finally {
    await cleanup()
  }
})

test('inspect：不保存也能判断是空文件夹、已有库还是文件', async () => {
  const { call, saved, root, parent, cleanup } = await harness()
  try {
    const missing = await call('inspect', { root: path.join(parent, '还不存在') })
    assert.equal(missing.ok, true)
    assert.equal(missing.value.exists, false)

    // 先建一个真库，再探查它：应该报出笔记数，界面才能提示「点保存路径生效」
    await call('initLibrary')
    const full = await call('inspect', { root: root.replace(/\\/g, '/') })
    assert.equal(full.ok, true)
    assert.equal(full.value.exists, true)
    assert.equal(full.value.readable, true)
    assert.equal(full.value.notes, 3)

    const file = path.join(parent, 'a.md')
    await fs.writeFile(file, '# x\n', 'utf8')
    const asFile = await call('inspect', { root: file })
    assert.equal(asFile.ok, false)
    assert.match(asFile.error, /是文件，不是目录/)

    const relative = await call('inspect', { root: 'relative/B2' })
    assert.equal(relative.ok, false)
    assert.match(relative.error, /需要绝对路径/)

    // 探查只读：全程不写配置
    assert.deepEqual(saved, [])
  } finally {
    await cleanup()
  }
})

test('initLibrary：带新路径时就在那个路径建库，并把配置切过去', async () => {
  const { call, saved, parent, cleanup } = await harness()
  try {
    const other = path.join(parent, '另一个库')
    const result = await call('initLibrary', { root: other })
    assert.equal(result.ok, true)
    assert.equal(result.value.fresh, true)
    assert.equal(result.value.root, other)
    assert.equal(result.value.switched, true)
    assert.ok((await fs.stat(path.join(other, '00-Inbox'))).isDirectory())
    assert.deepEqual(saved.at(-1), { root: other })
  } finally {
    await cleanup()
  }
})

test('status 与 initLibrary 端点：库缺失 → exists:false；初始化后 exists:true', async () => {
  const { call, cleanup } = await harness()
  try {
    const before = await call('status')
    assert.equal(before.ok, true)
    assert.equal(before.value.exists, false)
    // 「目录不存在」要和「目录在但读不到」分开，界面才能给出不同建议
    assert.equal(before.value.missing, true)
    assert.match(before.value.reason, /库不存在/)

    const init = await call('initLibrary')
    assert.equal(init.ok, true)
    assert.equal(init.value.fresh, true)

    const after = await call('status')
    assert.equal(after.value.exists, true)
    assert.equal(after.value.notes, 3)

    const again = await call('initLibrary')
    assert.equal(again.value.fresh, false)
    assert.deepEqual(again.value.created, [])
  } finally {
    await cleanup()
  }
})

test('assign 端点：一次设置多名负责人，空数组清空，未知的人报错', async () => {
  const { call, store, cleanup } = await harness()
  try {
    await call('initLibrary')
    await store.createPerson({ name: '张三' })
    await store.createPerson({ name: '李四' })
    const project = await store.createNote({
      title: '联调',
      type: 'project',
      body: '# 联调\n\n## 任务\n- [ ] 对接接口\n',
    })
    const [task] = await store.listTasks({ scope: 'project' }).then(tasks => tasks.filter(item => item.path === project.path))

    const added = await call('assign', { path: task.path, line: task.line, names: ['张三', '李四'] })
    assert.equal(added.ok, true)
    assert.deepEqual(added.value.assignees, ['张三', '李四'])
    assert.equal(added.value.line, task.line)

    const cleared = await call('assign', { path: task.path, line: task.line, names: [] })
    assert.equal(cleared.ok, true)
    assert.deepEqual(cleared.value.assignees, [])

    // 老参数 name 仍然能用（单个负责人）
    const single = await call('assign', { path: task.path, line: task.line, name: '李四' })
    assert.deepEqual(single.value.assignees, ['李四'])

    const missing = await call('assign', { path: task.path, line: task.line, names: ['王五'] })
    assert.equal(missing.ok, false)
    assert.match(missing.error, /人员不存在/)
  } finally {
    await cleanup()
  }
})

test('未知 op 与非 POST 请求有明确错误', async () => {
  const { call, cleanup } = await harness()
  try {
    const unknown = await call('nope')
    assert.equal(unknown.ok, false)
    assert.match(unknown.error, /unknown-op/)
  } finally {
    await cleanup()
  }
})
