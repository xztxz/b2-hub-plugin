/** Frontmatter、checkbox 任务与日期解析。约定与 B2 设计文档第 4 节一致。 */

/**
 * 拆出笔记开头的 YAML frontmatter 块。
 * 只支持这些笔记用到的扁平标量与数组形式，不是完整 YAML 解析器。
 * @param {string} text
 * @returns {{ data: Record<string, unknown>, body: string }}
 */
export function splitFrontmatter(text) {
  const normalized = text.replace(/^\uFEFF/, '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(normalized)
  if (!match) return { data: {}, body: normalized }
  return { data: parseBlock(match[1]), body: normalized.slice(match[0].length) }
}

/**
 * @param {string} block
 * @returns {Record<string, unknown>}
 */
function parseBlock(block) {
  const data = {}
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    data[key] = parseScalar(value)
  }
  return data
}

/**
 * @param {string} value
 */
function parseScalar(value) {
  if (value === '') return ''
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map(item => stripQuotes(item.trim())).filter(item => item !== '')
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return stripQuotes(value)
}

/** @param {string} value */
function stripQuotes(value) {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if (first === '"' && last === '"') {
      // 序列化用的是 JSON 字符串（会转义引号与反斜杠），读回时对称还原。
      try {
        return JSON.parse(value)
      } catch {
        return value.slice(1, -1)
      }
    }
    if (first === "'" && last === "'") return value.slice(1, -1)
  }
  return value
}

/**
 * 把扁平记录序列化回 frontmatter 块（P3 写笔记时用）。
 * @param {Record<string, unknown>} data
 * @returns {string}
 */
export function serializeFrontmatter(data) {
  const lines = ['---']
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map(item => JSON.stringify(String(item))).join(', ')}]`)
      continue
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      lines.push(`${key}: ${value}`)
      continue
    }
    const text = String(value)
    lines.push(/^[\w\u4e00-\u9fa5 .\/#-]*$/.test(text) ? `${key}: ${text}` : `${key}: ${JSON.stringify(text)}`)
  }
  lines.push('---')
  return lines.join('\n')
}

/** 本地时间的今天，YYYY-MM-DD。 */
export function today() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * 校验本地日期字符串，只接受 YYYY-MM-DD。
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function normalizeDate(value) {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined
  return `${match[1]}-${match[2]}-${match[3]}`
}

/**
 * 与今天相差的整天数（正数表示未来）。
 * @param {string} date
 * @param {string} [from]
 */
export function dayDelta(date, from = today()) {
  const parse = value => {
    const [year, month, day] = value.split('-').map(Number)
    return Date.UTC(year, month - 1, day)
  }
  return Math.round((parse(date) - parse(from)) / 86_400_000)
}

/**
 * 截止日标记：`📅2026-11-20` 或 `due::2026-11-20`。
 * 写得不像真实日期（例如 2026-02-30）时不当成截止日，也不从标题里抹掉——
 * 用户打错字时应该还能看见自己写了什么。
 */
const DUE_MARKER_ALL = /(?:📅|due::)\s*(\d{4}-\d{2}-\d{2})/g
const DUE_MARKER_FIRST = /(?:📅|due::)\s*(\d{4}-\d{2}-\d{2})/

/**
 * 笔记正文中的 checkbox 任务。`@姓名` 指派、`⏱ 2h` 工时、`📅`/`due::` 截止；
 * 这些标记会从标题里剥离（无效日期除外）。
 * @param {string} body
 * @returns {{ line: number, indent: number, checked: boolean, title: string, due?: string, effort?: number, assignees: string[], tags: string[] }[]}
 */
export function parseTasks(body) {
  const tasks = []
  const lines = body.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(lines[index])
    if (!match) continue
    const rest = match[3]
    const dueMarker = DUE_MARKER_FIRST.exec(rest)
    const due = dueMarker === null ? undefined : normalizeDate(dueMarker[1])
    const effortMatch = /⏱\s*(\d+(?:\.\d+)?)\s*(?:h|小时|hr)?/.exec(rest)
    const effort = effortMatch ? Number(effortMatch[1]) : undefined
    // 指派支持两种写法：`@[[姓名]]`（Obsidian 双链）与 `@姓名`（纯文本）。
    // 一个任务可以有多名负责人，重复写同一个人只算一次（顺序保留第一次出现的位置）。
    const assignees = [...new Set([...rest.matchAll(/(?:^|\s)@\[\[([^\]\n]+)\]\]|(?:^|\s)@([^\s@#[]+)/g)]
      .map(item => (item[1] ?? item[2]).trim())
      .filter(name => name !== ''))]
    const title = rest
      .replace(DUE_MARKER_ALL, (whole, date) => (normalizeDate(date) === undefined ? whole : ''))
      .replace(/⏱\s*\d+(?:\.\d+)?\s*(?:h|小时|hr)?/g, '')
      .replace(/(?:^|\s)@\[\[[^\]\n]+\]\]/g, ' ')
      .replace(/(?:^|\s)@[^\s@#[]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const tags = [...rest.matchAll(/(?:^|\s)#([\w\u4e00-\u9fa5\/-]+)/g)].map(item => item[1])
    tasks.push({ line: index + 1, indent: match[1].length, checked: match[2].toLowerCase() === 'x', title, due, effort, assignees, tags })
  }
  return tasks
}

/**
 * 去掉受管 `## 任务` 段落后的正文。
 * @param {string} body
 */
export function bodyWithoutTaskSection(body) {
  const lines = body.split(/\r?\n/)
  const start = lines.findIndex(line => /^##\s+任务\s*$/.test(line.trim()))
  if (start === -1) return body
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+\S/.test(lines[index].trim())) {
      end = index
      break
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n')
}

/**
 * frontmatter 块占用的行数，用于把正文行号换算成整文件行号。
 * @param {string} content
 * @returns {number}
 */
export function frontmatterLineOffset(content) {
  const { body } = splitFrontmatter(content)
  return content.slice(0, content.length - body.length).split(/\r?\n/).length - 1
}

/**
 * 笔记标题：frontmatter.title → 正文第一个一级标题 → 文件名。
 * @param {Record<string, unknown>} data
 * @param {string} body
 * @param {string} fallback
 */
export function noteTitle(data, body, fallback) {
  if (typeof data.title === 'string' && data.title.trim() !== '') return data.title.trim()
  const heading = /^#\s+(.+)$/m.exec(body)
  if (heading !== null) return heading[1].trim()
  return fallback
}
