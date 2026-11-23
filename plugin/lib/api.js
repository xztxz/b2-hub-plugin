/** 同源 JSON 端点：侧栏面板用它读数据、勾任务。 */

import fs from 'node:fs/promises'

import { resolveRoot } from './settings.js'
import { createStore } from './store.js'

/** 请求体上限，避免异常大的请求占内存。 */
const MAX_BODY = 1_000_000

const API_PATH = '/b2-hub/api'

/** @param {import('node:http').IncomingMessage} req */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** @param {import('node:http').ServerResponse} res */
function respond(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 拒绝跨站请求：浏览器从别处发来的调用一律不处理。 */
function sameOrigin(req) {
  const host = req.headers.host
  const origin = req.headers.origin
  if (origin) {
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
  return true
}

/**
 * 注册面板端点。没有 web 服务时静默降级：工具照常工作，只是没有界面。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {(patch: Record<string, unknown>) => Promise<void>} saveConfig
 * @param {ReturnType<import('./settings.js').normalizeSettings>} settings
 */
export function registerApi(ctx, store, saveConfig, settings) {
  const webServer = ctx.webServer ?? ctx.get?.('webServer')
  if (webServer === undefined) return () => {}

  const operations = {
    /** 库状态（设置页用，不抛错）：区分「目录不存在」与「读不到」。 */
    async status() {
      try {
        const notes = await store.listNotes()
        return { root: store.root, exists: true, notes: notes.length }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { root: store.root, exists: false, missing: error?.code === 'ROOT_MISSING', reason: message }
      }
    },
    /** 保存库根路径（会写入插件配置并重启插件）。 */
    async saveRoot(input) {
      const raw = String(input?.root ?? '')
      // 按人话写法解析：`~/vault/B2`、`%USERPROFILE%\B2`、带引号的整串都算数。
      const resolved = resolveRoot(raw)
      if (raw.trim() === '') throw new Error('库根路径不能为空')
      if (resolved === '') throw new Error(`需要绝对路径（或用 ~ 开头的路径）：${raw.trim()}`)
      const stat = await fs.stat(resolved).catch(() => undefined)
      if (stat !== undefined && !stat.isDirectory()) throw new Error(`这个路径是文件，不是目录：${resolved}`)
      await saveConfig({ root: resolved })
      const exists = stat !== undefined
      return {
        root: resolved,
        exists,
        note: exists
          ? '路径已保存，插件正在重启'
          : '路径已保存，但该目录还不存在：点「初始化此库」建好结构即可用',
      }
    },
    /**
     * 探查某个目录（目录选择器选完后用）：不保存配置、不写任何文件。
     * 返回它是不是可用库、读不读得到、有几篇笔记，界面据此切换下一步。
     */
    async inspect(input) {
      const raw = String(input?.root ?? '')
      if (raw.trim() === '') throw new Error('库根路径不能为空')
      const resolved = resolveRoot(raw)
      if (resolved === '') throw new Error(`需要绝对路径（或用 ~ 开头的路径）：${raw.trim()}`)
      const stat = await fs.stat(resolved).catch(() => undefined)
      if (stat === undefined) return { root: resolved, exists: false }
      if (!stat.isDirectory()) throw new Error(`这个路径是文件，不是目录：${resolved}`)
      const probe = createStore({ ...settings, root: resolved })
      try {
        const notes = await probe.listNotes()
        return { root: resolved, exists: true, readable: true, notes: notes.length }
      } catch (error) {
        return {
          root: resolved,
          exists: true,
          readable: false,
          reason: error instanceof Error ? error.message : String(error),
        }
      }
    },
    /**
     * 初始化库：补全结构；新库才放 1 个示例项目 + 1 个示例人员。
     * 带 root 时就在那个路径建（用户刚填、还没保存的路径），建好后把配置切过去。
     */
    async initLibrary(input) {
      const raw = typeof input?.root === 'string' ? input.root : ''
      if (raw.trim() === '') return await store.initLibrary()
      const wanted = resolveRoot(raw)
      if (wanted === '') throw new Error(`需要绝对路径（或用 ~ 开头的路径）：${raw.trim()}`)
      if (wanted === store.root) return await store.initLibrary()
      const target = createStore({ ...settings, root: wanted })
      const result = await target.initLibrary()
      await saveConfig({ root: wanted })
      return { ...result, switched: true, note: '已在这个路径建好库，并把配置切过去（插件正在重启）' }
    },
    /** 面板主数据。 */
    async panel() {
      return await store.panelData()
    },
    /** 勾选/取消一行任务。 */
    async toggle(input) {
      const note = await store.readNote(input.path)
      const result = await store.toggleTask({ path: input.path, line: input.line, expect: note.hash })
      return { done: result.done, conflict: result.conflict }
    },
    /** 重新生成 90-Overview。 */
    async overview() {
      return await store.writeOverview()
    },
    /** 随手记一行到收件箱或指定项目。 */
    async capture(input) {
      return await store.capture(input?.text, input?.target)
    },
    /** 把一行任务移到另一篇笔记。 */
    async move(input) {
      return await store.moveTask(input?.path, input?.line, input?.target)
    },
    /** 新建项目：建 10-Projects/<名字>/<名字>.md。 */
    async createProject(input) {
      const name = String(input?.name ?? '').trim()
      if (name === '') throw new Error('项目名不能为空')
      const result = await store.createNote({ title: name, type: 'project' })
      return { path: result.path, name }
    },
    /** 某个人的完整任务历史（含已完成），右侧滑入页用。 */
    async personHistory(input) {
      return await store.personHistory(input?.name)
    },
    /** 整体设置一行任务的负责人名单（一个任务可多人负责）；`names: []` 表示清空。 */
    async assign(input) {
      const names = Array.isArray(input?.names)
        ? input.names
        : (typeof input?.name === 'string' && input.name.trim() !== '' ? [input.name] : [])
      const note = await store.readNote(input.path)
      const result = await store.setAssignees({
        path: input.path,
        line: input.line,
        names,
        expect: note.hash,
      })
      return { path: result.path, line: input.line, assignees: result.assignees }
    },
    /** 设置或清除一行任务的截止日。 */
    async setDue(input) {
      const note = await store.readNote(input.path)
      const result = await store.setDue({
        path: input.path,
        line: input.line,
        due: input.due,
        expect: note.hash,
      })
      return { path: result.path, due: result.due ?? null }
    },
  }

  return webServer.register({
    kind: 'prefix',
    path: API_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        respond(res, 405, { ok: false, error: '只接受 POST' })
        return
      }
      if (!sameOrigin(req)) {
        respond(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      const type = String(req.headers['content-type'] ?? '').toLowerCase()
      if (!type.includes('application/json')) {
        respond(res, 415, { ok: false, error: 'content-type 必须是 application/json' })
        return
      }
      let request
      try {
        request = JSON.parse(await readBody(req))
      } catch {
        respond(res, 400, { ok: false, error: 'invalid-json' })
        return
      }
      const op = String(request?.op ?? '')
      const handler = operations[op]
      if (handler === undefined) {
        respond(res, 404, { ok: false, error: `unknown-op: ${op}` })
        return
      }
      try {
        respond(res, 200, { ok: true, value: await handler(request?.args ?? {}) })
      } catch (error) {
        respond(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}
