/**
 * B2 笔记/任务中枢 — DSH 宿主。
 *
 * 第一个适配器：读取与写入 B2 的本地 Markdown 库，并提供侧栏面板与设置页。
 * 设计文档见仓库根 DESIGN.md；行为契约见 HOST-CONTRACT.md。
 *
 * 零运行时依赖，只用 Node 内置模块。
 */

import { registerApi } from './lib/api.js'
import { normalizeSettings } from './lib/settings.js'
import { createStore } from './lib/store.js'
import { registerTools } from './lib/tools.js'

export const name = 'b2-hub'
export const inject = ['tools']

/**
 * 通过 DSH 的配置编辑器保存插件配置（改动会让插件重启）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} patch
 */
async function saveConfig(ctx, patch) {
  const entry = ctx.fiber?.entry
  if (entry === undefined) throw new Error('当前会话无法保存配置：插件入口不可用')
  const editor = ctx.get('configEditor')
  if (editor === undefined) throw new Error('当前配置无法保存：configEditor 服务不可用')
  await editor.edit(entry, current => ({ ...current, ...patch }))
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown> | undefined} config
 */
export function apply(ctx, config) {
  const settings = normalizeSettings(config)
  const store = createStore(settings)
  registerTools(ctx, store, settings)

  // webServer 由 web 运行时后挂载：apply 时它还不在，必须延迟注入。
  // 没有 web 服务时这段永不执行，工具照常可用。
  ctx.inject(['webServer'], webCtx => {
    webCtx.effect(() => registerApi(webCtx, store, patch => saveConfig(ctx, patch), settings), 'b2-hub:api')
  })
}
