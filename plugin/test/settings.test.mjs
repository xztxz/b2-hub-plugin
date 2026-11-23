import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DEFAULTS, normalizeSettings, resolveRoot } from '../lib/settings.js'

test('默认库根不写死盘符，落在用户家目录下', () => {
  assert.equal(DEFAULTS.root, path.join(os.homedir(), 'vault', 'B2'))
  assert.equal(normalizeSettings({}).root, path.join(os.homedir(), 'vault', 'B2'))
})

test('~ 展开成当前用户家目录，而不是 cwd 下名为 ~ 的目录', () => {
  assert.equal(resolveRoot('~/vault/B2'), path.join(os.homedir(), 'vault', 'B2'))
  assert.equal(resolveRoot('~'), os.homedir())
  // 只展开开头的 ~，路径中间的 ~ 原样保留
  assert.equal(resolveRoot('C:/a/~/b'), path.resolve('C:/a/~/b'))
})

test('环境变量写法（%VAR% 与 ${VAR}）会展开', () => {
  process.env.B2_TEST_ROOT = path.join(os.tmpdir(), 'b2-root')
  assert.equal(resolveRoot('%B2_TEST_ROOT%'), path.join(os.tmpdir(), 'b2-root'))
  assert.equal(resolveRoot('${B2_TEST_ROOT}/sub'), path.join(os.tmpdir(), 'b2-root', 'sub'))
  // 未定义的变量原样保留；展开后仍是相对路径，因此不算有效库根
  assert.equal(resolveRoot('%B2_NOPE_XYZ%'), '')
})

test('带引号的粘贴路径会去掉引号', () => {
  const target = path.resolve('C:/Users/x/B2')
  assert.equal(resolveRoot(`"${target}"`), target)
  assert.equal(resolveRoot(`  '${target}'  `), target)
})

test('空值与非法类型不会变成 cwd', () => {
  assert.equal(resolveRoot(''), '')
  assert.equal(resolveRoot('   '), '')
  assert.equal(resolveRoot(undefined), '')
  assert.equal(resolveRoot(42), '')
  // 配置里给空 root 时保留默认值
  assert.equal(normalizeSettings({ root: '   ' }).root, DEFAULTS.root)
})

test('目录角色字段会归一成 / 分隔且去首尾斜杠', () => {
  const settings = normalizeSettings({ inboxFolder: '\\00-Inbox\\', projectsFolder: '/10-Projects/' })
  assert.equal(settings.inboxFolder, '00-Inbox')
  assert.equal(settings.projectsFolder, '10-Projects')
  assert.equal(settings.peopleFolder, '20-People')
  assert.equal(settings.overviewPath, '90-Overview.md')
})

test('excluded 去重且丢弃非字符串', () => {
  const settings = normalizeSettings({ excluded: ['.obsidian', '.obsidian', 7, '  '] })
  assert.deepEqual(settings.excluded, ['.obsidian'])
})

test('相对路径不算库根：回落默认值，而不是悄悄指向 cwd', () => {
  assert.equal(resolveRoot('relative/B2'), '')
  assert.equal(resolveRoot('./B2'), '')
  assert.equal(normalizeSettings({ root: './relative/B2' }).root, DEFAULTS.root)
  for (const raw of ['~/vault/B2', '%USERPROFILE%\\B2']) {
    assert.ok(path.isAbsolute(normalizeSettings({ root: raw }).root), `${raw} 应当解析成绝对路径`)
  }
})
