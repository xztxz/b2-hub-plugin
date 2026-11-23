/** B2 中枢配置：库根、目录角色与默认值。纯函数，不读写磁盘。 */

import os from 'node:os'
import path from 'node:path'

export const DEFAULTS = {
  /**
   * B2 库根目录。故意用可移植写法（`~` 在家目录下展开），
   * 不写死某个盘符：换电脑时路径必然不同，库在哪由设置决定，不由插件决定。
   * 库不存在时报错，插件不会自动创建（初始化按钮除外）。
   */
  root: path.join(os.homedir(), 'vault', 'B2'),
  /** 一级目录：四位角色，前缀两位宽、步长 10。 */
  inboxFolder: '00-Inbox',
  projectsFolder: '10-Projects',
  peopleFolder: '20-People',
  /** 汇总笔记，可由任意宿主重新生成。 */
  overviewPath: '90-Overview.md',
  /** 永不扫描的目录（同步/工具产生的噪音）。 */
  excluded: ['.obsidian', '.dsh-backup', '.trash', 'node_modules'],
}

/** 包在引号里的路径：Explorer 的「复制为路径」会带引号。 */
const QUOTED = /^(['"])([\s\S]*)\1$/

/**
 * 把用户输入的库根路径展开成绝对路径。
 *
 * 支持三种人话写法（设置页 placeholder 里推荐的正是前两种）：
 *   - `~/vault/B2`、`~\vault\B2` —— 展开到当前用户家目录；
 *   - `%USERPROFILE%\B2`、`${HOME}/B2` —— 展开环境变量（未定义的原样保留）；
 *   - 带引号的整串（`"C:\vault\B2"`）—— 去掉引号。
 *
 * 返回空串表示没有给出有效路径（或给了相对路径），调用方自行决定报错还是回退。
 * @param {unknown} value
 * @returns {string}
 */
export function resolveRoot(value) {
  if (typeof value !== 'string') return ''
  let text = value.trim()
  if (text === '') return ''
  const quoted = QUOTED.exec(text)
  if (quoted !== null) text = quoted[2].trim()
  if (text === '') return ''
  // 只展开开头的 `~`，避免把路径中间的 `~` 当成家目录。
  text = text.replace(/^~(?=$|[\\/])/, os.homedir())
  text = text.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name) => process.env[name] ?? whole)
  text = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) => process.env[name] ?? whole)
  // 相对路径不算有效库根：它依赖进程 cwd，换一个宿主就会指向别处。
  return path.isAbsolute(text) ? path.normalize(text) : ''
}

/**
 * 应用默认值并清洗不可用值。
 * @param {Record<string, unknown> | undefined} raw
 */
export function normalizeSettings(raw) {
  const settings = { ...DEFAULTS, excluded: [...DEFAULTS.excluded] }
  const source = raw ?? {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue
    if (key === 'excluded') {
      if (Array.isArray(value)) {
        settings.excluded = [...new Set(value.filter(item => typeof item === 'string' && item.trim() !== ''))]
      }
      continue
    }
    if (typeof value !== 'string') continue
    const text = value.trim()
    if (text === '') continue
    if (key === 'root') {
      const resolved = resolveRoot(text)
      if (resolved !== '') settings.root = resolved
      continue
    }
    if (key === 'inboxFolder' || key === 'projectsFolder' || key === 'peopleFolder' || key === 'overviewPath') {
      settings[key] = text.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    }
  }
  return settings
}
