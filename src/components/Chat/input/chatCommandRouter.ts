/**
 * chatCommandRouter — 斜杠命令解析与执行
 *
 * 将 /nexus / /agent / /dispatch / /assault 四类本地命令的解析+执行从 ChatInput 迁出，
 * ChatInput 只需调用 tryHandleSlashCommand(text, ctx)，根据返回结果执行清理/发送。
 *
 * 返回值语义：
 * - { handled: false }        未命中命令，ChatInput 继续正常发送流程
 * - { handled: true }         命中并已执行，ChatInput 清空输入并 return
 * - { handled: true, sendText } 命中但需把 sendText 作为普通消息发送
 */

import { parseNexusSlashCommand, parseAgentSlashCommand, rewriteDispatchPromptWithAgent, NEXUS_SCENARIOS } from '@/services/agentSlashCommand'
import { parseDispatchSlashCommand, dispatchFromUser } from '@/services/dispatchTaskService'
import { parseAssaultSlashCommand } from '@/services/cliSlashCommands'
import {
  buildCapDetailBlock,
  buildCapDigestBlock,
  matchCaps,
  parseCapSlashCommand,
} from '@/services/capSlashCommand'
import { useCapCatalogStore } from '@/stores/capCatalogStore'
import { invoke as transportInvoke } from '@/services/transport'
import { useToastStore } from '@/stores/toastStore'
import { useAgentStore } from '@/stores/agentStore'
import { useSessionConfig } from '@/stores/sessionConfigStore'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import i18n from 'i18next'

export interface SlashCommandContext {
  /** 当前活跃会话 ID（用于 /nexus sourceSessionId、/agent metadata 写入） */
  activeSessionId: string | null
}

export type SlashCommandResult =
  | { handled: false }
  | { handled: true; sendText?: string }

/**
 * 尝试处理斜杠命令。返回 { handled: true } 表示已处理（ChatInput 应清空输入）。
 */
export function tryHandleSlashCommand(text: string, ctx: SlashCommandContext): SlashCommandResult {
  const trimmed = text.trim()

  // /cap [查询] [正文] → 注入 cap 能力协议速查（数据实时来自 cap.help，经 capCatalogStore 会话级缓存）
  const capCmd = parseCapSlashCommand(trimmed)
  if (capCmd) {
    const catalog = useCapCatalogStore.getState()
    if (!catalog.loaded) {
      // 未就绪：触发加载并引导重试（斜杠建议弹出时已预载，正常路径此处已命中缓存）
      void catalog.ensure()
      useToastStore.getState().info('/cap', i18n.t('chat:capCmd.notReady', {
        defaultValue: 'cap 目录加载中或后端未响应，请稍候重试',
      }))
      return { handled: true }
    }
    const caps = useCapCatalogStore.getState().caps
    if (caps.length === 0) {
      useToastStore.getState().info('/cap', i18n.t('chat:capCmd.emptyCatalog', {
        defaultValue: '总线上没有任何已注册能力（cap.help index 返回为空）',
      }))
      return { handled: true }
    }
    if (!capCmd.rest) {
      useToastStore.getState().info('/cap', i18n.t('chat:capCmd.usage', {
        defaultValue: '用法：/cap 全量速查 ｜ /cap <cap id 或中文短名> [你想让 AI 做的事]',
      }))
      return { handled: true }
    }
    const matches = capCmd.firstToken ? matchCaps(caps, capCmd.firstToken) : []
    if (matches.length === 1 && matches[0]) {
      // 唯一命中：正文在前，该能力完整协议块在末尾（末尾包含契约）
      const detail = buildCapDetailBlock(matches[0])
      return { handled: true, sendText: capCmd.remainder ? `${capCmd.remainder}\n\n${detail}` : detail }
    }
    if (matches.length > 1) {
      useToastStore.getState().info('/cap', i18n.t('chat:capCmd.ambiguous', {
        defaultValue: '匹配到多个：{{list}}——请用建议列表点选或更精确的查询',
        list: matches.slice(0, 5).map((c) => `${c.id}（${c.name}）`).join('、'),
        interpolation: { escapeValue: false },
      }))
      return { handled: true }
    }
    // 首个 token 不命中（或无 token）：整体视为正文在前，末尾注入全量速查
    const digest = buildCapDigestBlock(caps)
    return { handled: true, sendText: capCmd.rest ? `${capCmd.rest}\n\n${digest}` : digest }
  }

  // /nexus <scenario> <goal> → 组队派发（拓扑波次）
  const nexusCmd = parseNexusSlashCommand(trimmed)
  if (nexusCmd) {
    if (!nexusCmd.goal || !NEXUS_SCENARIOS.includes(nexusCmd.scenario as (typeof NEXUS_SCENARIOS)[number])) {
      useToastStore.getState().info('/nexus', `用法：/nexus <${NEXUS_SCENARIOS.join('|')}> 团队目标`)
      return { handled: true }
    }
    void transportInvoke('nexus_start_roster', {
      scenario: nexusCmd.scenario,
      goal: nexusCmd.goal,
      sourceSessionId: ctx.activeSessionId ?? undefined,
      mode: nexusCmd.mode,
    }).then((r) => {
      const res = r as { rosterId: string; waves: string[][]; dispatchedNow: string[] }
      useToastStore.getState().info(
        'NEXUS 组队已启动',
        `${nexusCmd.scenario}：${res.waves.length} 波共 ${res.waves.flat().length} 人，首波已派发 ${res.dispatchedNow.length} 人`,
      )
    }).catch((e) => {
      useToastStore.getState().error('/nexus 派发失败', e instanceof Error ? e.message : String(e))
    })
    return { handled: true }
  }

  // /agent [slug] → 设为/清除当前专家
  const agentCmd = parseAgentSlashCommand(trimmed)
  if (agentCmd) {
    const { catalog, customAgents } = useAgentStore.getState()
    const knownSlug = (slug: string) =>
      catalog.some((a) => a.slug === slug) || customAgents.some((c) => c.slug === slug)
    if (agentCmd.slug && (catalog.length > 0 || customAgents.length > 0) && !knownSlug(agentCmd.slug)) {
      useToastStore.getState().info('/agent', i18n.t('chat:agentCmd.unknownSlug', {
        defaultValue: '未找到专家「{{slug}}」，可在专家画廊中查找 slug',
        slug: agentCmd.slug,
        interpolation: { escapeValue: false },
      }))
    } else {
      useSessionConfig.getState().setAgent(agentCmd.slug ?? '')
      if (ctx.activeSessionId) {
        sessionStoreManager.getState().updateSessionAgent(ctx.activeSessionId, agentCmd.slug ?? null)
      }
      useToastStore.getState().info('/agent', agentCmd.slug
        ? i18n.t('chat:agentCmd.set', { defaultValue: '当前专家已设为 {{slug}}', slug: agentCmd.slug, interpolation: { escapeValue: false } })
        : i18n.t('chat:agentCmd.cleared', '已清除当前专家'))
    }
    return { handled: true }
  }

  // /dispatch [@角色|<agent-slug>] 任务内容 → 派发到后台会话执行
  const dispatchCmd = parseDispatchSlashCommand(trimmed)
  if (dispatchCmd) {
    if (!dispatchCmd.role) {
      const agentState = useAgentStore.getState()
      const rewrite = rewriteDispatchPromptWithAgent(
        dispatchCmd.prompt,
        [
          ...agentState.customAgents.map((c) => ({
            slug: c.slug, name: c.name, description: c.description,
            emoji: c.emoji ?? undefined, filePath: c.filePath,
            systemPrompt: c.systemPrompt,
          })),
          ...agentState.catalog,
        ],
        null,
      )
      if (rewrite) {
        dispatchCmd.prompt = rewrite.prompt
        dispatchCmd.role = rewrite.slug
        if (rewrite.systemPrompt) {
          dispatchCmd.appendSystemPrompt = rewrite.systemPrompt
        }
      }
    }
    void dispatchFromUser(dispatchCmd)
    return { handled: true }
  }

  // /assault <profile> <problem> → 剥离 / 前缀后作为普通文本发送
  const assaultText = parseAssaultSlashCommand(trimmed)
  if (assaultText) {
    return { handled: true, sendText: assaultText }
  }

  return { handled: false }
}
