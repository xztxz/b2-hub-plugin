import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bodyWithoutTaskSection,
  dayDelta,
  frontmatterLineOffset,
  normalizeDate,
  noteTitle,
  parseTasks,
  serializeFrontmatter,
  splitFrontmatter,
  today,
} from '../lib/markdown.js'

test('任务行：截止日、指派、工时、标签都能解析，标题里不留日期与指派', () => {
  const [task] = parseTasks('- [ ] 写周报 📅2026-11-20 @[[张三]] @李四 ⏱ 2h #工作报告')
  // 标签保留在标题里（Obsidian 里它就是正文的一部分），日期与指派则被剥离
  assert.equal(task.title, '写周报 #工作报告')
  assert.equal(task.due, '2026-11-20')
  assert.deepEqual(task.assignees, ['张三', '李四'])
  assert.equal(task.effort, 2)
  assert.deepEqual(task.tags, ['工作报告'])
  assert.equal(task.checked, false)
  assert.equal(task.line, 1)
})

test('任务行：同一个负责人写两遍只算一次，顺序按首次出现', () => {
  const [task] = parseTasks('- [ ] 联调 @[[张三]] @张三 @[[李四]]')
  assert.deepEqual(task.assignees, ['张三', '李四'])
  assert.equal(task.title, '联调')
})

test('任务行：已完成、缩进、dure:: 写法与编号行都认得', () => {
  const tasks = parseTasks(['  - [x] 已完成的活 due::2026-11-18', '- [ ] 第二行'].join('\n'))
  assert.equal(tasks[0].checked, true)
  assert.equal(tasks[0].indent, 2)
  assert.equal(tasks[0].due, '2026-11-18')
  assert.equal(tasks[1].line, 2)
})

test('任务行：非法日期不当作截止日，也不从标题里抹掉', () => {
  const [task] = parseTasks('- [ ] 假日期 📅2026-02-30')
  assert.equal(task.due, undefined)
  assert.equal(task.title, '假日期 📅2026-02-30')
})

test('frontmatter：拆出数据与正文，兼容 BOM 与 CRLF', () => {
  const content = '\uFEFF---\r\ntype: project\r\nstatus: active\r\n---\r\n\r\n# 标题\r\n'
  const { data, body } = splitFrontmatter(content)
  assert.equal(data.type, 'project')
  assert.equal(data.status, 'active')
  assert.equal(body.trim(), '# 标题')
})

test('frontmatter：没有 frontmatter 时正文就是全文', () => {
  const { data, body } = splitFrontmatter('# 只有正文\n')
  assert.deepEqual(data, {})
  assert.equal(body, '# 只有正文\n')
})

test('frontmatter：序列化后能被自己解析回来（含特殊字符）', () => {
  const data = { type: 'project', status: 'active', priority: 'high', tags: ['a', 'b'], note: '含: 冒号与 "引号"' }
  const parsed = splitFrontmatter(`${serializeFrontmatter(data)}\n\n# x\n`).data
  assert.deepEqual(parsed, data)
})

test('日期校验：只接受真实存在的 YYYY-MM-DD', () => {
  assert.equal(normalizeDate('2026-11-20'), '2026-11-20')
  assert.equal(normalizeDate('2026-02-30'), undefined)
  assert.equal(normalizeDate('2026-13-01'), undefined)
  assert.equal(normalizeDate('26-11-20'), undefined)
  assert.equal(normalizeDate(''), undefined)
})

test('dayDelta：按本地日期算整天差', () => {
  assert.equal(dayDelta('2026-11-20', '2026-11-19'), 1)
  assert.equal(dayDelta('2026-11-18', '2026-11-19'), -1)
  assert.equal(dayDelta('2026-11-19', '2026-11-19'), 0)
  assert.equal(dayDelta('2026-12-01', '2026-11-19'), 12)
})

test('today() 是本地 YYYY-MM-DD', () => {
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/)
})

test('受管的 ## 任务 段会被整段去掉，其余小节保留', () => {
  const body = ['# 张三', '', '角色说明', '', '## 任务', '', '- [[项目]] · 某任务', '', '## 备注', '别删我'].join('\n')
  const stripped = bodyWithoutTaskSection(body)
  assert.ok(!stripped.includes('## 任务'))
  assert.ok(!stripped.includes('某任务'))
  assert.ok(stripped.includes('## 备注'))
  assert.ok(stripped.includes('别删我'))
})

test('行号偏移：正文行号 + 偏移 = 整文件行号', () => {
  const content = '---\ntype: note\ncreated: 2026-11-19\n---\n\n# 标题\n\n- [ ] 任务\n'
  const offset = frontmatterLineOffset(content)
  const body = splitFrontmatter(content).body
  const task = parseTasks(body)[0]
  const lines = content.split('\n')
  assert.equal(lines[task.line + offset - 1], '- [ ] 任务')
})

test('标题回退顺序：frontmatter.title → 一级标题 → 文件名', () => {
  assert.equal(noteTitle({ title: '来自字段' }, '# 标题', '文件名'), '来自字段')
  assert.equal(noteTitle({}, '# 标题\n', '文件名'), '标题')
  assert.equal(noteTitle({}, '没有标题', '文件名'), '文件名')
})
