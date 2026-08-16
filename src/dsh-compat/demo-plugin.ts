/**
 * Demo DSH Plugin — 验证 Cordis 运行时
 *
 * 一个最小化的 Cordis 插件，在 Polaris 的 CordisHost 中加载。
 * 验证 ctx.effect + ctx.get('tools') 等核心机制。
 * 导出格式：name + inject + apply（标准 Cordis plugin 约定）
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'demo-polaris-plugin'
export const inject = ['tools']

export function apply(ctx: Context) {
  const tools = ctx.get('tools') as any
  tools.register({
    name: 'polaris_hello',
    description: '验证 Cordis 运行时的 demo 工具',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '你的名字' },
      },
      required: ['name'],
    },
  })
}