/**
 * Store 契约的文件适配器。
 *
 * 行为契约见仓库根 HOST-CONTRACT.md；本节只负责把它映射到本地文件。
 * 读：listNotes / readNote / listTasks；
 * 写：createNote / writeNote / toggleTask / setDue / assign / overview。
 *
 * 写入约定：
 *   · 原子写（同目录临时文件 + rename），不会留下半个文件；
 *   · UTF-8 无 BOM、LF 换行；
 *   · 所有写操作都带 `expect`（读到的 hash）；不一致时最后写入赢，
 *     同时返回 conflict: true，由宿主提示可能覆盖了别处的修改。
 *
 * 错误一律带 code（见契约第 8 节），消息给人看。
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  dayDelta,
  frontmatterLineOffset,
  noteTitle,
  normalizeDate,
  parseTasks,
  serializeFrontmatter,
  splitFrontmatter,
  today,
} from './markdown.js'

/** 单个文件读取上限，超过则跳过并记录，避免误读大文件。 */
const MAX_FILE_BYTES = 2_000_000

/** checkbox 任务行。 */
const TASK_LINE = /^(\s*)[-*]\s+\[( |x|X)\]\s+(.*)$/

/** 抛出带错误码的失败。 */
function fail(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

/**
 * @param {ReturnType<import('./settings.js').normalizeSettings>} settings
 */
export function createStore(settings) {
  const root = settings.root
  const excluded = new Set(settings.excluded)

  /** 库根必须存在；不存在时报错，绝不自动创建。 */
  async function requireRoot() {
    const stat = await fs.stat(root).catch(() => undefined)
    if (stat === undefined || !stat.isDirectory()) {
      fail('ROOT_MISSING', `B2 库不存在：${root}。请先创建该目录；b2-hub 不会自动创建库。`)
    }
    return root
  }

  /** 库内相对路径 → 绝对路径，并确保没有逃出库根。 */
  function resolveInside(relative, { allowRoot = false } = {}) {
    if (typeof relative !== 'string' || relative.trim() === '') fail('INVALID_ARGS', '路径不能为空')
    const normalized = relative.trim().replace(/\\/g, '/')
    if (path.isAbsolute(normalized)) fail('OUTSIDE_ROOT', `只接受库内相对路径：${relative}`)
    const resolved = path.resolve(root, normalized)
    const inside = path.relative(root, resolved)
    if (!allowRoot && (inside === '' || inside.startsWith('..') || path.isAbsolute(inside))) {
      fail('OUTSIDE_ROOT', `路径必须位于 B2 库内：${relative}`)
    }
    if (allowRoot && inside.startsWith('..')) fail('OUTSIDE_ROOT', `路径必须位于 B2 库内：${relative}`)
    return resolved
  }

  /** 递归列出所有 markdown 文件（库内相对路径）。 */
  async function walk(relative = '') {
    const directory = relative === '' ? root : path.join(root, relative)
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
    const files = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (excluded.has(entry.name)) continue
      const next = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) files.push(...await walk(next))
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(next)
    }
    return files
  }

  /** 读取一篇笔记的原始内容。 */
  async function readContent(relative) {
    const absolute = resolveInside(relative)
    const stat = await fs.stat(absolute).catch(() => undefined)
    if (stat === undefined || !stat.isFile()) fail('NOT_FOUND', `笔记不存在：${relative}`)
    if (stat.size > MAX_FILE_BYTES) fail('FILE_TOO_LARGE', `笔记过大（${stat.size} B），已跳过：${relative}`)
    const content = await fs.readFile(absolute, 'utf8')
    return { content, stat }
  }

  /** @param {string} content */
  function hashOf(content) {
    return createHash('sha256').update(content, 'utf8').digest('hex')
  }

  /** 同目录临时文件 + rename，保证同步工具永远看不到半个文件。 */
  async function atomicWrite(absolute, content) {
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    const temp = `${absolute}.${process.pid}.${Date.now()}.b2tmp`
    try {
      await fs.writeFile(temp, content, 'utf8')
      await fs.rename(temp, absolute)
    } catch (error) {
      await fs.rm(temp, { force: true })
      throw error
    }
  }

  /** 标题 → 安全的文件名（不含扩展名）。 */
  function fileNameOf(title) {
    const cleaned = String(title)
      .replace(/\.{2,}/g, '-')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s-]+|[.\s-]+$/g, '')
    return cleaned === '' ? '未命名' : cleaned
  }

  /** 正文按行拆分，保留原文件的换行风格与末尾换行。 */
  function splitLines(content) {
    const trailing = content.endsWith('\n')
    const lines = content.split('\n')
    if (trailing) lines.pop()
    return { lines, trailing }
  }

  /** 读取 → 校验 expect → 变换 → 原子写。 */
  async function editContent(relative, expect, transform) {
    await requireRoot()
    const absolute = resolveInside(relative)
    const before = await fs.readFile(absolute, 'utf8').catch(() => undefined)
    if (before === undefined) fail('NOT_FOUND', `笔记不存在：${relative}`)
    const beforeHash = hashOf(before)
    const expectGiven = typeof expect === 'string' && expect !== ''
    // 界面只显示 hash 前缀，因此按前缀接受（至少 10 位，足够区分一次修改）。
    const expectMatches = expectGiven
      && (expect === beforeHash || (expect.length >= 10 && beforeHash.startsWith(expect)))
    const conflict = expectGiven && !expectMatches
    const after = transform(before)
    if (typeof after !== 'string') throw new Error('内部错误：变换没有返回内容')
    if (after !== before) await atomicWrite(absolute, after)
    return { path: relative, hash: hashOf(after), previousHash: beforeHash, conflict }
  }

  /** 在指定整文件行上执行变换；行号越界或不是任务行时报错。 */
  function editTaskLine(content, line, transform) {
    if (!Number.isInteger(line) || line < 1) fail('LINE_OUT_OF_RANGE', `行号必须是正整数：${line}`)
    const { lines, trailing } = splitLines(content)
    if (line > lines.length) fail('LINE_OUT_OF_RANGE', `行号越界：第 ${line} 行，文件共 ${lines.length} 行`)
    const original = lines[line - 1]
    const match = TASK_LINE.exec(original)
    if (match === null) fail('NOT_A_TASK_LINE', `第 ${line} 行不是 checkbox 任务：${original.trim()}`)
    lines[line - 1] = transform(original, match)
    return `${lines.join('\n')}${trailing ? '\n' : ''}`
  }

  /**
   * 列出笔记的元信息，不返回正文。
   * @param {{ type?: string, query?: string }} [filter]
   */
  async function listNotes(filter = {}) {
    await requireRoot()
    const type = typeof filter.type === 'string' && filter.type.trim() !== '' ? filter.type.trim() : undefined
    const query = typeof filter.query === 'string' && filter.query.trim() !== '' ? filter.query.trim().toLowerCase() : undefined
    const notes = []
    for (const relative of await walk()) {
      const { content, stat } = await readContent(relative).catch(error => {
        if (error?.code === 'FILE_TOO_LARGE') return { content: '', stat: { mtimeMs: 0 } }
        throw error
      })
      const { data, body } = splitFrontmatter(content)
      const noteType = typeof data.type === 'string' && data.type !== '' ? data.type : 'note'
      const title = noteTitle(data, body, path.basename(relative, '.md'))
      if (type !== undefined && noteType !== type) continue
      if (query !== undefined && !`${relative}\n${title}`.toLowerCase().includes(query)) continue
      notes.push({
        path: relative,
        type: noteType,
        title,
        status: typeof data.status === 'string' ? data.status : undefined,
        created: typeof data.created === 'string' ? data.created : undefined,
        due: typeof data.due === 'string' ? data.due : undefined,
        updated: new Date(stat.mtimeMs).toISOString(),
      })
    }
    return notes.sort((left, right) => left.path.localeCompare(right.path, 'zh'))
  }

  /**
   * 读取一篇笔记：frontmatter、正文、内容 hash（写操作的冲突检测用）。
   * @param {string} relative
   */
  async function readNote(relative) {
    await requireRoot()
    const { content, stat } = await readContent(relative)
    const { data, body } = splitFrontmatter(content)
    return {
      path: relative,
      frontmatter: data,
      body,
      hash: hashOf(content),
      size: stat.size,
      updated: new Date(stat.mtimeMs).toISOString(),
    }
  }

  /**
   * 列出任务。`line` 是整文件行号，可直接交给 toggleTask / setDue / assign。
   * @param {{ scope?: 'all' | 'project' | 'inbox', assignee?: string, includeDone?: boolean }} [filter]
   */
  async function listTasks(filter = {}) {
    await requireRoot()
    const scope = filter.scope === 'project' || filter.scope === 'inbox' ? filter.scope : 'all'
    const assignee = typeof filter.assignee === 'string' && filter.assignee.trim() !== '' ? filter.assignee.trim() : undefined
    const includeDone = filter.includeDone === true
    const tasks = []
    for (const relative of await walk()) {
      if (scope === 'project' && !relative.startsWith(`${settings.projectsFolder}/`)) continue
      if (scope === 'inbox' && !relative.startsWith(`${settings.inboxFolder}/`)) continue
      const { content } = await readContent(relative).catch(() => ({ content: '' }))
      const { data, body } = splitFrontmatter(content)
      const created = typeof data.created === 'string' ? data.created : undefined
      const offset = frontmatterLineOffset(content)
      for (const task of parseTasks(body)) {
        if (!includeDone && task.checked) continue
        if (assignee !== undefined && !task.assignees.includes(assignee)) continue
        tasks.push({
          path: relative,
          line: task.line + offset,
          title: task.title,
          done: task.checked,
          due: task.due,
          created,
          assignees: task.assignees,
          effort: task.effort,
          tags: task.tags,
        })
      }
    }
    return tasks.sort((left, right) => {
      if (left.due !== right.due) {
        if (left.due === undefined) return 1
        if (right.due === undefined) return -1
        return left.due.localeCompare(right.due)
      }
      const byPath = left.path.localeCompare(right.path, 'zh')
      return byPath !== 0 ? byPath : left.line - right.line
    })
  }

  /**
   * 新建笔记；同名文件已存在时报错，绝不覆盖。
   * @param {{ title: string, type?: string, folder?: string, body?: string, frontmatter?: Record<string, unknown> }} input
   */
  async function createNote(input) {
    await requireRoot()
    const title = String(input.title ?? '').trim()
    if (title === '') fail('INVALID_ARGS', '标题不能为空')
    const type = typeof input.type === 'string' && input.type.trim() !== '' ? input.type.trim() : 'note'
    const folder = typeof input.folder === 'string' && input.folder.trim() !== ''
      ? input.folder.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      : defaultFolderFor(type, title)
    const fileName = `${fileNameOf(title)}.md`
    const relative = folder === '' ? fileName : `${folder}/${fileName}`
    const absolute = resolveInside(relative)
    const data = {
      type,
      created: today(),
      ...(type === 'project' ? { status: 'active' } : {}),
      ...normalizeFrontmatter(input.frontmatter),
    }
    const body = typeof input.body === 'string' ? input.body : `# ${title}\n`
    const content = `${serializeFrontmatter(data)}\n\n${normalizeBody(body)}`
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    const handle = await fs.open(absolute, 'wx').catch(error => {
      if (error?.code === 'EEXIST') fail('ALREADY_EXISTS', `笔记已存在，未覆盖：${relative}`)
      throw error
    })
    try {
      await handle.writeFile(content, 'utf8')
    } finally {
      await handle.close()
    }
    return { path: relative, hash: hashOf(content) }
  }

  /** 类型 → 默认目录。项目按「一项目一目录」约定。 */
  function defaultFolderFor(type, title) {
    if (type === 'project') return `${settings.projectsFolder}/${fileNameOf(title)}`
    if (type === 'person') return settings.peopleFolder
    return settings.inboxFolder
  }

  /**
   * 写入一篇已存在的笔记。frontmatter / body 省略时保留原值。
   * @param {{ path: string, expect: string, frontmatter?: Record<string, unknown>, body?: string }} input
   */
  async function writeNote(input) {
    const result = await editContent(input.path, input.expect, content => {
      const { data, body } = splitFrontmatter(content)
      const nextData = input.frontmatter === undefined ? data : { ...data, ...normalizeFrontmatter(input.frontmatter) }
      const nextBody = input.body === undefined ? body : normalizeBody(input.body)
      return `${serializeFrontmatter(nextData)}\n\n${nextBody}`
    })
    return { ...result, ok: true }
  }

  /**
   * 勾选 / 取消勾选一行任务。
   * @param {{ path: string, line: number, expect: string, done?: boolean }} input
   */
  async function toggleTask(input) {
    let next = false
    let lineAssignees = []
    const result = await editContent(input.path, input.expect, content => editTaskLine(content, input.line, original => {
      const match = TASK_LINE.exec(original)
      const target = input.done === undefined ? match[2].toLowerCase() !== 'x' : input.done === true
      next = target
      const line = original.replace(/^(\s*[-*]\s+\[)( |x|X)(\])/, `$1${target ? 'x' : ' '}$3`)
      lineAssignees = parseTasks(line)[0]?.assignees ?? []
      return line
    }))
    if (lineAssignees.length > 0) await syncPeople(lineAssignees)
    return { ...result, done: next }
  }

  /**
   * 设置或清除任务的截止日（📅YYYY-MM-DD）。
   * @param {{ path: string, line: number, expect: string, due?: string | null }} input
   */
  async function setDue(input) {
    const raw = input.due === undefined || input.due === null ? '' : String(input.due).trim()
    const due = raw === '' ? undefined : normalizeDate(raw)
    if (raw !== '' && due === undefined) fail('INVALID_DATE', `日期格式必须是 YYYY-MM-DD：${input.due}`)
    let lineAssignees = []
    const result = await editContent(input.path, input.expect, content => editTaskLine(content, input.line, original => {
      const stripped = original
        .replace(/\s*📅\s*\d{4}-\d{2}-\d{2}/g, '')
        .replace(/\s*due::\s*\d{4}-\d{2}-\d{2}/g, '')
        .replace(/\s+$/, '')
      const line = due === undefined
        ? stripped
        : (() => {
            const at = stripped.indexOf(' @')
            if (at === -1) return `${stripped} 📅${due}`
            return `${stripped.slice(0, at)} 📅${due}${stripped.slice(at)}`
          })()
      lineAssignees = parseTasks(line)[0]?.assignees ?? []
      return line
    }))
    if (lineAssignees.length > 0) await syncPeople(lineAssignees)
    return { ...result, due }
  }

  /** 姓名不能带空格 / @ / # / 方括号，否则 `@[[姓名]]` 语法会坏掉。 */
  function assertName(name) {
    if (/[\s@#[\]]/.test(name)) fail('INVALID_ARGS', `姓名不能包含空格、@ 或 #：${name}`)
  }

  /** 一次要校验一批人：都必须是 20-People 下已有的人员笔记。 */
  async function assertPeopleExist(names) {
    if (names.length === 0) return
    const people = await listNotes({ type: 'person' })
    const known = new Set(people.map(person => person.title))
    const missing = names.filter(name => !known.has(name))
    if (missing.length === 0) return
    fail('NOT_FOUND', `人员不存在：${missing.join('、')}。请先建人员笔记（${settings.peopleFolder} 下 type: person），或用 b2_create_person。`)
  }

  /**
   * 增删任务上的 @姓名 指派；幂等。一个任务可以有多名负责人。
   * `name` 与 `names` 可同时给，合并后去重。
   * @param {{ path: string, line: number, expect: string, name?: string, names?: string[], action?: 'add' | 'remove' }} input
   */
  async function assign(input) {
    const action = input.action === 'remove' ? 'remove' : 'add'
    const names = nameList(input.names, input.name)
    if (names.length === 0) fail('INVALID_ARGS', '至少给一个姓名：name 或 names')
    for (const name of names) assertName(name)
    if (action === 'add') await assertPeopleExist(names)
    let assignees = []
    const result = await editContent(input.path, input.expect, content => editTaskLine(content, input.line, original => {
      // 指派写成 Obsidian 双链，这样任务所在笔记会自动出现在人员笔记的反向链接里。
      let line = original
      for (const name of names) line = action === 'add' ? linkAssignee(line, name) : unlinkAssignee(line, name)
      assignees = parseTasks(line)[0]?.assignees ?? []
      return line
    }))
    await syncPeople(names)
    return { ...result, assignees, action, names }
  }

  /** 生成 90-Overview 的正文。纯读取，不写盘，便于任意宿主复用同一份口径。 */
  async function buildOverview() {
    await requireRoot()
    const notes = await listNotes()
    const tasks = await listTasks()
    const projects = notes.filter(note => note.type === 'project')
    const overdue = tasks.filter(task => task.due !== undefined && dayDelta(task.due) < 0)
    const thisWeek = tasks.filter(task => {
      if (task.due === undefined) return false
      const delta = dayDelta(task.due)
      return delta >= 0 && delta <= 7
    })
    const unassigned = tasks.filter(task => task.assignees.length === 0)
    const lines = ['---', 'type: note', `generated: ${new Date().toISOString()}`, '---', '', '# 90-Overview', '']

    lines.push(`## 项目（${projects.length}）`, '')
    if (projects.length === 0) lines.push('（暂无项目）')
    for (const project of projects) {
      const scoped = tasks.filter(task => task.path.startsWith(`${settings.projectsFolder}/${project.title}/`))
      const meta = [project.status, project.due === undefined ? undefined : `📅${project.due}`].filter(Boolean).join(' · ')
      lines.push(`- **${project.title}**${meta === '' ? '' : ` · ${meta}`} · 未完成 ${scoped.length} 个 — ${project.path}`)
    }

    lines.push('', `## 逾期（${overdue.length}）`, '')
    if (overdue.length === 0) lines.push('（无）')
    for (const task of overdue) {
      lines.push(`- ⚠️ ${task.title} · 📅${task.due} · 已过期 ${Math.abs(dayDelta(task.due))} 天 — ${task.path}:${task.line}`)
    }

    lines.push('', `## 本周（${thisWeek.length}）`, '')
    if (thisWeek.length === 0) lines.push('（无）')
    for (const task of thisWeek) {
      const who = task.assignees.length === 0 ? '' : ` @${task.assignees.join(' @')}`
      lines.push(`- ${task.title}${who} · 📅${task.due} — ${task.path}:${task.line}`)
    }

    lines.push('', `## 未指派（${unassigned.length}）`, '')
    if (unassigned.length === 0) lines.push('（无）')
    for (const task of unassigned) {
      const due = task.due === undefined ? '无截止日' : `📅${task.due}`
      lines.push(`- ${task.title} · ${due} — ${task.path}:${task.line}`)
    }

    lines.push('', '---', '', '由 b2_overview 生成，可随时重新生成；不要手工编辑这一篇。', '')
    return lines.join('\n')
  }

  /** 重新生成 90-Overview.md。它是生成物，不走 expect 冲突检测。 */
  async function writeOverview() {
    await requireRoot()
    const content = await buildOverview()
    const absolute = resolveInside(settings.overviewPath)
    await atomicWrite(absolute, content)
    return { path: settings.overviewPath, hash: hashOf(content), projects: (await listNotes({ type: 'project' })).length }
  }

  /**
   * 面板数据：项目一览 + 三个任务分组。给侧栏界面用，结构比 overview 更紧凑。
   */
  async function panelData() {
    await requireRoot()
    const tasks = await listTasks()
    const notes = await listNotes({ type: 'project' })
    const withProject = task => ({
      ...task,
      project: task.path.startsWith(`${settings.projectsFolder}/`) ? task.path.split('/')[1] : undefined,
    })
    return {
      root,
      projects: notes.map(note => {
        const scoped = tasks.filter(task => task.path.startsWith(`${settings.projectsFolder}/${note.title}/`))
        return {
          title: note.title,
          status: note.status,
          created: note.created,
          due: note.due,
          path: note.path,
          open: scoped.length,
          overdue: scoped.filter(task => task.due !== undefined && dayDelta(task.due) < 0).length,
          earliestDue: scoped.reduce((earliest, task) => {
            if (task.due === undefined) return earliest
            return earliest === undefined || task.due < earliest ? task.due : earliest
          }, undefined),
          tasks: scoped.map(task => ({ ...task, project: note.title })),
        }
      }),
      people: await listPeople(),
      overdue: tasks.filter(task => task.due !== undefined && dayDelta(task.due) < 0).map(withProject),
      thisWeek: tasks.filter(task => {
        if (task.due === undefined) return false
        const delta = dayDelta(task.due)
        return delta >= 0 && delta <= 7
      }).map(withProject),
      unassigned: tasks.filter(task => task.assignees.length === 0).map(withProject),
      // 「未归项目」的任务：不在任何项目目录下的（收件箱等），待办页处理它们。
      unfiled: tasks.filter(task => !task.path.startsWith(`${settings.projectsFolder}/`)).map(withProject),
    }
  }

  /**
   * 列出人员：名字、角色、在手任务与逾期数。
   */
  async function listPeople() {
    await requireRoot()
    const notes = await listNotes({ type: 'person' })
    const tasks = await listTasks()
    const people = []
    for (const note of notes) {
      const { frontmatter } = await readNote(note.path).catch(() => ({ frontmatter: {} }))
      const mine = tasks.filter(task => task.assignees.includes(note.title))
      people.push({
        path: note.path,
        name: note.title,
        role: typeof frontmatter.role === 'string' && frontmatter.role.trim() !== '' ? frontmatter.role.trim() : undefined,
        created: typeof frontmatter.created === 'string' ? frontmatter.created : undefined,
        open: mine.length,
        overdue: mine.filter(task => task.due !== undefined && dayDelta(task.due) < 0).length,
        tasks: mine.map(task => ({
          path: task.path,
          line: task.line,
          title: task.title,
          due: task.due,
          assignees: task.assignees,
          project: task.path.startsWith(`${settings.projectsFolder}/`) ? task.path.split('/')[1] : undefined,
        })),
      })
    }
    return people.sort((left, right) => left.name.localeCompare(right.name, 'zh'))
  }

  /**
   * 建一篇人员笔记。同名已存在时报错。
   * @param {{ name: string, role?: string, body?: string }} input
   */
  async function createPerson(input) {
    await requireRoot()
    const name = String(input?.name ?? '').trim()
    if (name === '') fail('INVALID_ARGS', '姓名不能为空')
    if (/[\s@#]/.test(name)) fail('INVALID_ARGS', `姓名不能包含空格、@ 或 #：${name}`)
    const relative = `${settings.peopleFolder}/${fileNameOf(name)}.md`
    const absolute = resolveInside(relative)
    const role = typeof input?.role === 'string' ? input.role.trim() : ''
    const data = { type: 'person', ...(role === '' ? {} : { role }), created: today() }
    const body = typeof input?.body === 'string' && input.body.trim() !== '' ? input.body : `# ${name}\n`
    const content = `${serializeFrontmatter(data)}\n\n${normalizeBody(body)}`
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    const handle = await fs.open(absolute, 'wx').catch(error => {
      if (error?.code === 'EEXIST') fail('ALREADY_EXISTS', `人员已存在，未覆盖：${relative}`)
      throw error
    })
    try {
      await handle.writeFile(content, 'utf8')
    } finally {
      await handle.close()
    }
    return { path: relative, name, role: role === '' ? undefined : role, hash: hashOf(content) }
  }
  /** 人员笔记里的任务清单：进行中 + 已完成，都用双链指回任务所在笔记。 */
  function personTaskSection(active, done) {
    const render = tasks => tasks.map(task => {
      const noteName = path.basename(task.path, '.md')
      const due = task.due === undefined ? '' : ` 📅${task.due}`
      return `- [[${noteName}]] · ${task.title}${due}`
    })
    const activeLines = active.length === 0 ? ['（无）'] : render(active)
    const doneLines = done.length === 0 ? ['（无）'] : render(done)
    return [
      '## 任务',
      '',
      `### 进行中（${active.length}）`,
      '',
      ...activeLines,
      '',
      `### 已完成（${done.length}）`,
      '',
      ...doneLines,
      '',
    ].join('\n')
  }

  /** 把 `## 任务` 段整体替换成给定内容（没有该段就追加）。 */
  function replaceTaskSection(content, section) {
    const lines = content.split('\n')
    const start = lines.findIndex(line => /^##\s+任务\s*$/.test(line.trim()))
    if (start === -1) return `${content.replace(/\s*$/, '')}\n\n${section}`
    let end = lines.length
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^##\s+\S/.test(lines[index].trim())) {
        end = index
        break
      }
    }
    const merged = [...lines.slice(0, start), ...section.split('\n'), ...lines.slice(end)].join('\n')
    return merged.replace(/\n{3,}/g, '\n\n')
  }

  /**
   * 同步人员笔记的任务清单。names 省略时同步全部人员。
   * @param {string[]} [names]
   */
  async function syncPeople(names) {
    await requireRoot()
    const tasks = await listTasks({ includeDone: true })
    const people = await listNotes({ type: 'person' })
    const wanted = Array.isArray(names) && names.length > 0 ? new Set(names) : undefined
    const synced = []
    for (const person of people) {
      if (wanted !== undefined && !wanted.has(person.title)) continue
      const absolute = resolveInside(person.path)
      const current = await fs.readFile(absolute, 'utf8').catch(() => undefined)
      if (current === undefined) continue
      const mine = tasks.filter(task => task.assignees.includes(person.title))
      const active = mine.filter(task => !task.done)
      const done = mine.filter(task => task.done)
      const next = replaceTaskSection(current, personTaskSection(active, done))
      if (next !== current) await atomicWrite(absolute, next)
      synced.push({ name: person.title, tasks: active.length, done: done.length, changed: next !== current })
    }
    return synced
  }

  /**
   * 某个人的完整任务历史（含已完成），用于面板的滑入页。
   * @param {string} name
   */
  async function personHistory(name) {
    await requireRoot()
    const wanted = String(name ?? '').trim()
    const people = await listNotes({ type: 'person' })
    const person = people.find(item => item.title === wanted)
    if (person === undefined) fail('NOT_FOUND', `人员不存在：${wanted}`)
    const { frontmatter } = await readNote(person.path).catch(() => ({ frontmatter: {} }))
    const all = await listTasks({ includeDone: true })
    const withProject = task => ({
      ...task,
      project: task.path.startsWith(`${settings.projectsFolder}/`) ? task.path.split('/')[1] : undefined,
    })
    const mine = all.filter(task => task.assignees.includes(wanted)).map(withProject)
    return {
      name: wanted,
      role: typeof frontmatter.role === 'string' ? frontmatter.role : undefined,
      active: mine.filter(task => !task.done),
      done: mine.filter(task => task.done),
    }
  }

  async function taskTargetPath(target) {
    const wanted = typeof target === 'string' ? target.trim() : ''
    if (wanted === '' || wanted === 'inbox') return `${settings.inboxFolder}/收件箱.md`
    const projects = await listNotes({ type: 'project' })
    const matched = projects.find(project => project.title === wanted || project.path.split('/')[1] === wanted)
    if (matched !== undefined) return matched.path
    fail('NOT_FOUND', `项目不存在：${wanted}`)
  }

  /** 把一行任务插到 `## 任务` 标题下（没有该标题就补一个）。 */
  function insertTaskLine(content, line) {
    const lines = content.split('\n')
    const index = lines.findIndex(item => /^##\s+任务\s*$/.test(item.trim()))
    if (index === -1) {
      return `${content.replace(/\s*$/, '')}\n\n## 任务\n${line}\n`
    }
    lines.splice(index + 1, 0, line)
    return lines.join('\n')
  }

  /** 新建收件箱时用的空壳。 */
  function inboxScaffold() {
    return `---\ntype: note\ncreated: ${today()}\n---\n\n# 收件箱\n\n## 任务\n`
  }

  /**
   * 随手记：往目标笔记追加一行任务。target 省略或 'inbox' 时进收件箱。
   * 正文里已经存在的 @姓名 会升级成 `@[[姓名]]` 双链（Obsidian 侧才有反向链接）。
   * @param {string} text
   * @param {string} [target]
   */
  async function capture(text, target) {
    await requireRoot()
    const value = String(text ?? '').replace(/\s+/g, ' ').trim()
    if (value === '') fail('INVALID_ARGS', '内容不能为空')
    const relative = await taskTargetPath(target)
    const absolute = resolveInside(relative)
    const existing = await fs.readFile(absolute, 'utf8').catch(() => undefined)
    const created = existing === undefined
    if (created && relative !== `${settings.inboxFolder}/收件箱.md`) fail('NOT_FOUND', `笔记不存在：${relative}`)
    const assignees = parseTasks(`- [ ] ${value}`)[0]?.assignees ?? []
    let line = `- [ ] ${value}`
    if (assignees.length > 0) {
      const known = new Set((await listNotes({ type: 'person' })).map(note => note.title))
      for (const name of assignees) {
        if (!known.has(name)) continue
        line = line.replace(new RegExp(`(^|\\s)@${escapeRegExp(name)}(?=\\s|$)`, 'g'), `$1@[[${name}]]`)
      }
    }
    const before = created ? inboxScaffold() : existing
    const after = insertTaskLine(before.endsWith('\n') ? before : `${before}\n`, line)
    await atomicWrite(absolute, after)
    if (assignees.length > 0) await syncPeople(assignees)
    return { path: relative, text: value, created, assignees, hash: hashOf(after) }
  }

  /**
   * 把一行任务从所在笔记移到另一篇笔记的 `## 任务` 下。
   * @param {string} path
   * @param {number} line
   * @param {string} target
   */
  async function moveTask(path, line, target) {
    await requireRoot()
    const destination = await taskTargetPath(target)
    if (destination === path) return { path, line, moved: false, reason: '已经在目标笔记里' }
    const sourceAbsolute = resolveInside(path)
    const source = await fs.readFile(sourceAbsolute, 'utf8').catch(() => undefined)
    if (source === undefined) fail('NOT_FOUND', `笔记不存在：${path}`)
    if (!Number.isInteger(line) || line < 1) fail('LINE_OUT_OF_RANGE', `行号必须是正整数：${line}`)
    const lines = source.split('\n')
    const raw = lines[line - 1]
    if (raw === undefined) fail('LINE_OUT_OF_RANGE', `行号越界：第 ${line} 行`)
    if (TASK_LINE.exec(raw) === null) fail('NOT_A_TASK_LINE', `第 ${line} 行不是 checkbox 任务`)
    const taskLine = raw.replace(/\s+$/, '')
    lines.splice(line - 1, 1)
    const sourceAfter = lines.join('\n')

    const destinationAbsolute = resolveInside(destination)
    const destinationBefore = await fs.readFile(destinationAbsolute, 'utf8').catch(() => undefined)
    if (destinationBefore === undefined) fail('NOT_FOUND', `笔记不存在：${destination}`)
    const destinationAfter = insertTaskLine(
      destinationBefore.endsWith('\n') ? destinationBefore : `${destinationBefore}\n`,
      taskLine,
    )

    await atomicWrite(sourceAbsolute, sourceAfter)
    await atomicWrite(destinationAbsolute, destinationAfter)
    const assignees = parseTasks(taskLine)[0]?.assignees ?? []
    if (assignees.length > 0) await syncPeople(assignees)
    return {
      path: destination,
      from: path,
      moved: true,
      title: parseTasks(taskLine)[0]?.title ?? taskLine,
    }
  }

  /**
   * 整体设置一行任务的负责人名单（面板用）：清掉原有指派，按给定顺序写回；传空表示清空。
   * @param {{ path: string, line: number, expect: string, names?: string[], name?: string }} input
   */
  async function setAssignees(input) {
    const names = nameList(input.names, input.name)
    for (const name of names) assertName(name)
    await assertPeopleExist(names)
    const before = await fs.readFile(resolveInside(input.path), 'utf8').catch(() => undefined)
    if (before === undefined) fail('NOT_FOUND', `笔记不存在：${input.path}`)
    const previous = parseTasks((before.split('\n')[input.line - 1] ?? ''))[0]?.assignees ?? []
    let next = []
    const result = await editContent(input.path, input.expect, content => editTaskLine(content, input.line, original => {
      const stripped = stripAssignees(original)
      let line = stripped
      for (const name of names) line = linkAssignee(line, name)
      next = parseTasks(line)[0]?.assignees ?? []
      return line
    }))
    await syncPeople([...new Set([...previous, ...next])])
    return { ...result, assignees: next, names }
  }

  /**
   * 设置一行任务的唯一负责人（单人选人的老接口）：传空表示清空。
   * @param {{ path: string, line: number, expect: string, name?: string }} input
   */
  async function setAssignee(input) {
    const name = String(input.name ?? '').trim()
    const result = await setAssignees({
      path: input.path,
      line: input.line,
      expect: input.expect,
      names: name === '' ? [] : [name],
    })
    return { ...result, name }
  }

  /**
   * 初始化库：补全结构；只在新库时放 1 个示例项目 + 1 个示例人员。
   * 规则：不覆盖任何已有文件；已存在的库只补缺失的目录与 90-Overview。
   */
  async function initLibrary() {
    const created = []
    const rootStat = await fs.stat(root).catch(() => undefined)
    const fresh = rootStat === undefined || !rootStat.isDirectory()
    await fs.mkdir(root, { recursive: true })
    if (fresh) created.push('（库根）')

    for (const folder of [settings.inboxFolder, settings.projectsFolder, settings.peopleFolder]) {
      const absolute = path.join(root, folder)
      const stat = await fs.stat(absolute).catch(() => undefined)
      if (stat === undefined) {
        await fs.mkdir(absolute, { recursive: true })
        created.push(folder)
      }
    }

    const overviewAbsolute = resolveInside(settings.overviewPath)
    const overviewStat = await fs.stat(overviewAbsolute).catch(() => undefined)
    if (overviewStat === undefined) {
      await atomicWrite(overviewAbsolute, `---\ntype: note\ncreated: ${today()}\n---\n\n# 90-Overview\n\n由 b2_overview 生成，可随时重新生成；不要手工编辑这一篇。\n`)
      created.push(settings.overviewPath)
    }

    // 示例只在「新建的库」里放，且各一个；已存在的库不添乱。
    if (fresh) {
      const sampleProject = `${settings.projectsFolder}/示例项目/示例项目.md`
      const samplePerson = `${settings.peopleFolder}/示例成员.md`
      const due = (() => {
        const date = new Date()
        date.setDate(date.getDate() + 2)
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      })()
      await atomicWrite(resolveInside(samplePerson), [
        '---',
        'type: person',
        'role: 成员',
        `created: ${today()}`,
        '---',
        '',
        '# 示例成员',
        '',
        '这是初始化时生成的示例人员，可以改名或删除。',
        '',
      ].join('\n'))
      await atomicWrite(resolveInside(sampleProject), [
        '---',
        'type: project',
        `created: ${today()}`,
        'status: active',
        '---',
        '',
        '# 示例项目',
        '',
        '这是初始化时生成的示例项目，可以改名或删除。',
        '',
        '## 任务',
        `- [ ] 从这里开始记第一件事 📅${due} @[[示例成员]]`,
        '',
      ].join('\n'))
      created.push(sampleProject, samplePerson)
      await syncPeople()
    }

    return { root, created, fresh }
  }

  return {
    root,
    listNotes,
    readNote,
    listTasks,
    createNote,
    writeNote,
    toggleTask,
    setDue,
    assign,
    buildOverview,
    writeOverview,
    panelData,
    capture,
    moveTask,
    listPeople,
    createPerson,
    syncPeople,
    setAssignee,
    setAssignees,
    personHistory,
    initLibrary,
  }
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 姓名名单：去空白、保序去重；`names` 数组与 `name` 单值可同时给。 */
function nameList(names, name) {
  const list = []
  const push = value => {
    const text = String(value ?? '').trim()
    if (text !== '' && !list.includes(text)) list.push(text)
  }
  if (Array.isArray(names)) {
    for (const item of names) push(item)
  } else {
    push(names)
  }
  push(name)
  return list
}

/** 折叠多余空格并去掉行尾空白，但保留行首缩进（嵌套任务要用）。 */
function tidyTaskLine(line) {
  const match = /^(\s*)([\s\S]*)$/.exec(line)
  return `${match[1]}${match[2].replace(/ {2,}/g, ' ').replace(/\s+$/, '')}`
}

/** 把一个负责人写成 `@[[姓名]]` 双链；已有就原样返回（幂等），老的 `@姓名` 顺手升级。 */
function linkAssignee(line, name) {
  const escaped = escapeRegExp(name)
  if (new RegExp(`(?:^|\\s)@\\[\\[${escaped}\\]\\]`).test(line)) return line
  const plain = new RegExp(`(?:^|\\s)@${escaped}(?=\\s|$)`)
  if (plain.test(line)) {
    return line.replace(plain, whole => (whole.startsWith(' ') ? ` @[[${name}]]` : `@[[${name}]]`))
  }
  return `${line.replace(/\s+$/, '')} @[[${name}]]`
}

/** 去掉某个负责人的两种写法。用空格占位，避免相邻的两个 @ 互相吃掉前面的空格。 */
function stripOneAssignee(line, name) {
  const escaped = escapeRegExp(name)
  return line
    .replace(new RegExp(`(?:^|\\s)@\\[\\[${escaped}\\]\\]`, 'g'), ' ')
    .replace(new RegExp(`(?:^|\\s)@${escaped}(?=\\s|$)`, 'g'), ' ')
}

/** 去掉一个人的全部出现（同一个人写了两遍时也要清干净）。 */
function unlinkAssignee(line, name) {
  let text = line
  for (let round = 0; round < 5; round += 1) {
    const next = stripOneAssignee(text, name)
    if (next === text) break
    text = next
  }
  return tidyTaskLine(text)
}

/** 去掉行上所有 `@姓名` / `@[[姓名]]`，其余文本不动。 */
function stripAssignees(line) {
  let text = line
  for (let round = 0; round < 5; round += 1) {
    const next = text
      .replace(/(?:^|\s)@\[\[[^\]\n]+\]\]/g, ' ')
      .replace(/(?:^|\s)@[^\s@#[]+/g, ' ')
    if (next === text) break
    text = next
  }
  return tidyTaskLine(text)
}

/** 只保留可无损序列化的 frontmatter 字段，忽略 undefined / null。 */
function normalizeFrontmatter(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue
    if (typeof item === 'string' && item.trim() === '') continue
    result[key] = item
  }
  return result
}

/** 正文统一为 LF，并保证以单个换行结尾。 */
function normalizeBody(value) {
  const text = String(value).replace(/\r\n?/g, '\n')
  return text.endsWith('\n') ? text : `${text}\n`
}
