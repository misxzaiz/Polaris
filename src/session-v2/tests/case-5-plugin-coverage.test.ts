/**
 * 案例 5：插件扩展点覆盖验证
 *
 * 验证假设 5：通过事件 hook + 存储可替换 + 仲裁策略可替换，
 * 能覆盖全部 6 类 AI 对话触发点。
 *
 * 6 类触发场景（来自 02-触发全景图.md）：
 * 1. 用户直接交互（sendMessage / continueChat / interrupt / regenerate）
 * 2. 后台静默会话（标题生成 / 提示词优化 / 提交信息生成 / 压缩交接）
 * 3. 调度器/派发任务（schedulerStore / dispatchTaskService）
 * 4. 历史恢复（historyService / webReconnectResync）
 * 5. 引擎层直接调用（engines/claude-code/session）
 * 6. isStreaming 消费方（自动滚动 / TTS / 提交信息订阅等 8 个）
 *
 * 每个场景写一个"模拟插件"，验证通过扩展点能完整复现当前行为。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryMessageLog } from '../core/in-memory-log'
import { InMemorySessionEventLog, InMemoryStateArbiter } from '../core/in-memory-state'
import { InMemoryPluginHost } from '../core/plugin-host'
import type {
  MessageEntry,
  SessionEventEntry,
  SessionRecord,
  SessionStatus,
  SessionPlugin,
} from '../core/types'

// ============================================================================
// 测试工具
// ============================================================================

let seqCounter = 0

function makeMsg(
  id: string,
  conversationId: string,
  role: 'user' | 'assistant' | 'system',
  timestamp: number,
  deviceId: string,
  content: Record<string, unknown> = {},
): MessageEntry {
  return { id, conversationId, role, timestamp, deviceId, content, version: 1 }
}

function makeEvent(
  conversationId: string,
  type: 'session_start' | 'session_end' | 'error',
  deviceId: string,
  timestamp: number,
  extra?: Partial<SessionEventEntry>,
): SessionEventEntry {
  return {
    id: `evt-${++seqCounter}`,
    conversationId,
    type,
    timestamp,
    deviceId,
    seq: seqCounter,
    ...extra,
  }
}

function makeRecord(
  id: string,
  engineId: string,
  extra?: Partial<Omit<SessionRecord, 'version' | 'createdAt' | 'updatedAt'>>,
): Omit<SessionRecord, 'version' | 'createdAt' | 'updatedAt'> {
  return {
    id,
    conversationId: null,
    title: '',
    engineId,
    workspaceId: null,
    contextWorkspaceIds: [],
    type: 'project',
    silentMode: false,
    messageIds: [],
    ...extra,
  }
}

const IDLE: SessionStatus = {
  conversationId: '',
  running: false,
  lastEventSeq: 0,
  error: null,
  startedAt: null,
  endedAt: null,
  startedByDevice: null,
}

// ============================================================================
// 6 类触发场景的模拟插件
// ============================================================================

/**
 * 场景 1：用户直接交互
 *
 * 复现 sendMessage 路径的行为：
 * - beforeAppendMessage：用户消息追加前注入 workspacePrompt 上下文
 * - onSessionStatusChange：状态变化时更新 UI 订阅
 */
function createUserInteractionPlugin() {
  const uiState = { lastRunning: false, eventCount: 0 }
  const plugin: SessionPlugin = {
    id: 'user-interaction',
    beforeAppendMessage(entry) {
      if (entry.role === 'user') {
        // 注入工作区上下文（复现当前 sendMessage 拼装 workspacePrompt 的行为）
        return {
          ...entry,
          content: {
            ...entry.content,
            workspacePrompt: '【工作区上下文】项目 Polaris',
          },
        }
      }
      return entry
    },
    onSessionStatusChange(_conv, _old, next) {
      uiState.lastRunning = next.running
      uiState.eventCount++
    },
  }
  return { plugin, uiState }
}

/**
 * 场景 2：后台静默会话
 *
 * 复现标题生成 titleGenerationService 的行为：
 * - beforeCreateSession：silentMode 会话跳过 UI 激活
 * - onSessionStatusChange：session_end 时触发标题生成
 */
function createSilentSessionPlugin() {
  const titles: Array<{ conversationId: string; text: string }> = []
  const activated = { silentSkipped: 0, normalActivated: 0 }
  const plugin: SessionPlugin = {
    id: 'silent-session',
    beforeCreateSession(record) {
      if (record.silentMode) {
        activated.silentSkipped++
        // 静默会话不激活 UI（复现 titleGenerationService 跳过前台创建）
        return record
      }
      activated.normalActivated++
      return record
    },
    onSessionStatusChange(conversationId, old, next) {
      // session_end 时触发标题生成（复现 titleGenerationService 监听结束事件）
      if (old.running && !next.running) {
        titles.push({ conversationId, text: `标题-${conversationId}` })
      }
    },
  }
  return { plugin, titles, activated }
}

/**
 * 场景 3：调度器/派发任务
 *
 * 复现 schedulerStore 路由 scheduler-{id} 的行为：
 * - onSessionStatusChange：session_end 时更新任务状态
 */
function createSchedulerPlugin() {
  const tasks: Array<{ taskId: string; status: string }> = []
  const plugin: SessionPlugin = {
    id: 'scheduler',
    onSessionStatusChange(conversationId, old, next) {
      if (old.running && !next.running) {
        tasks.push({ taskId: conversationId, status: next.error ? 'failed' : 'done' })
      }
    },
  }
  return { plugin, tasks }
}

/**
 * 场景 4：历史恢复
 *
 * 复现 historyService 恢复路径的行为：
 * - beforeCreateSession：恢复时设置 messageIds 引用
 */
function createHistoryRestorePlugin() {
  const restored: Array<{ sessionId: string; messageIds: string[] }> = []
  const plugin: SessionPlugin = {
    id: 'history-restore',
    beforeCreateSession(record) {
      if (record.kind === 'title-generation') return record
      // 恢复场景：从后端拉取消息 ID 列表并挂到新会话
      const messageIds = [`hist-${record.id}-1`, `hist-${record.id}-2`]
      restored.push({ sessionId: record.id, messageIds })
      return { ...record, messageIds }
    },
  }
  return { plugin, restored }
}

/**
 * 场景 5：引擎层直接调用
 *
 * 复现 engines/claude-code/session 直接发消息的行为：
 * - beforeAppendMessage：引擎层直接调用时注入 contextId 路由信息
 */
function createEngineDirectPlugin() {
  const routed: string[] = []
  const plugin: SessionPlugin = {
    id: 'engine-direct',
    beforeAppendMessage(entry) {
      if (entry.role === 'assistant') {
        // 引擎回传消息注入 contextId（复现 claude-code session 的 context 路由）
        const withContext = {
          ...entry,
          content: { ...entry.content, contextId: `ctx-${entry.conversationId}` },
        }
        routed.push(entry.conversationId)
        return withContext
      }
      return entry
    },
  }
  return { plugin, routed }
}

/**
 * 场景 6：isStreaming 消费方
 *
 * 复现自动滚动 / TTS / 提交信息订阅等 8 个消费方的行为：
 * - onSessionStatusChange：running 变化时触发消费方动作
 */
function createStreamingConsumerPlugin() {
  const consumers = {
    autoScroll: 0,
    tts: 0,
    commitMsg: 0,
  }
  const plugin: SessionPlugin = {
    id: 'streaming-consumer',
    onSessionStatusChange(_conv, old, next) {
      if (!old.running && next.running) {
        consumers.autoScroll++ // 自动滚动跟随
        consumers.tts++ // 语音伙伴开始朗读
      } else if (old.running && !next.running) {
        consumers.commitMsg++ // 提交信息订阅获取最终文本
      }
    },
  }
  return { plugin, consumers }
}

// ============================================================================
// 测试
// ============================================================================

describe('案例 5：插件扩展点覆盖验证', () => {
  let messageLog: InMemoryMessageLog
  let eventLog: InMemorySessionEventLog
  let arbiter: InMemoryStateArbiter
  let host: InMemoryPluginHost

  beforeEach(() => {
    seqCounter = 0
    messageLog = new InMemoryMessageLog()
    eventLog = new InMemorySessionEventLog()
    arbiter = new InMemoryStateArbiter(eventLog)
    host = new InMemoryPluginHost({ messageLog, eventLog, arbiter })
  })

  // ==========================================================================
  // 宿主加载机制（三阶段）
  // ==========================================================================

  describe('宿主加载机制', () => {
    it('三阶段：register → wire → run，run 阶段禁止注册', () => {
      expect(host.phase).toBe('register')
      host.register(createUserInteractionPlugin().plugin)
      host.advancePhase()
      expect(host.phase).toBe('wire')
      host.advancePhase()
      expect(host.phase).toBe('run')

      expect(() => host.register(createUserInteractionPlugin().plugin)).toThrow(
        /register 阶段已结束/,
      )
    })

    it('重复注册抛错', () => {
      host.register(createUserInteractionPlugin().plugin)
      expect(() => host.register(createUserInteractionPlugin().plugin)).toThrow(
        /插件重复注册/,
      )
    })

    it('依赖拓扑排序：依赖方排在依赖项之后', () => {
      const storage: SessionPlugin = { id: 'storage' }
      const cloud: SessionPlugin = {
        id: 'cloud-sync',
        dependencies: ['storage'],
        beforeCreateSession: r => r,
      }
      host.register(cloud)
      host.register(storage)
      host.advancePhase()
      host.advancePhase()

      const ids = host.listPlugins().map(p => p.id)
      expect(ids.indexOf('storage')).toBeLessThan(ids.indexOf('cloud-sync'))
    })

    it('依赖成环检测抛错', () => {
      host.register({ id: 'a', dependencies: ['b'] })
      host.register({ id: 'b', dependencies: ['a'] })
      expect(() => host.advancePhase()).toThrow(/依赖成环/)
    })

    it('依赖不存在的插件抛错', () => {
      host.register({ id: 'a', dependencies: ['ghost'] })
      expect(() => host.advancePhase()).toThrow(/依赖的插件不存在/)
    })

    it('run 阶段前分发 hook 抛错（防止插件未就绪时被调用）', async () => {
      host.register(createUserInteractionPlugin().plugin)
      await expect(
        host.dispatchBeforeAppendMessage(makeMsg('M1', 'conv', 'user', 1000, 'A')),
      ).rejects.toThrow(/插件未就绪/)
    })
  })

  // ==========================================================================
  // 场景 1：用户直接交互
  // ==========================================================================

  describe('场景 1：用户直接交互', () => {
    it('sendMessage → 消息注入工作区上下文 + 状态变为 running', async () => {
      const { plugin, uiState } = createUserInteractionPlugin()
      host.register(plugin)
      host.advancePhase()
      host.advancePhase()

      // 1. 用户发消息：beforeAppendMessage 注入 workspacePrompt
      const entry = makeMsg('U1', 'conv-1', 'user', 1000, 'device-A', { text: '你好' })
      const processed = await host.dispatchBeforeAppendMessage(entry)
      expect(processed!.content.workspacePrompt).toContain('Polaris')
      await messageLog.append(processed!)

      // 2. 会话开始：onSessionStatusChange 更新 UI
      const start = makeEvent('conv-1', 'session_start', 'device-A', 1000)
      await eventLog.append(start)
      const status = await arbiter.getStatus('conv-1')
      await host.dispatchOnSessionStatusChange('conv-1', IDLE, status)

      expect(uiState.lastRunning).toBe(true)
      expect(uiState.eventCount).toBe(1)

      // 3. 消息落库验证
      const msgs = await messageLog.read('conv-1')
      expect(msgs).toHaveLength(1)
      expect(msgs[0].id).toBe('U1')
    })

    it('interrupt → 消息被插件拦截阻止追加（返回 null）', async () => {
      // 模拟安全插件：拦截含敏感词的 user 消息
      const guard: SessionPlugin = {
        id: 'sensitive-guard',
        beforeAppendMessage(entry) {
          const text = JSON.stringify(entry.content)
          return text.includes('删除数据库') ? null : entry
        },
      }
      host.register(guard)
      host.advancePhase()
      host.advancePhase()

      const blocked = await host.dispatchBeforeAppendMessage(
        makeMsg('U1', 'conv-1', 'user', 1000, 'A', { text: '帮我删除数据库' }),
      )
      expect(blocked).toBeNull()

      const allowed = await host.dispatchBeforeAppendMessage(
        makeMsg('U2', 'conv-1', 'user', 2000, 'A', { text: '正常问题' }),
      )
      expect(allowed).not.toBeNull()
    })

    it('多插件链式传递：前一个插件修改的结果传给下一个', async () => {
      const p1: SessionPlugin = {
        id: 'p1',
        beforeAppendMessage: e => ({ ...e, content: { ...e.content, tag: 'a' } }),
      }
      const p2: SessionPlugin = {
        id: 'p2',
        beforeAppendMessage: e => ({
          ...e,
          content: { ...e.content, tag: `${e.content.tag}-b` },
        }),
      }
      host.register(p1)
      host.register(p2)
      host.advancePhase()
      host.advancePhase()

      const processed = await host.dispatchBeforeAppendMessage(
        makeMsg('U1', 'conv-1', 'user', 1000, 'A', { text: 'hi' }),
      )
      expect(processed!.content.tag).toBe('a-b')
    })
  })

  // ==========================================================================
  // 场景 2：后台静默会话
  // ==========================================================================

  describe('场景 2：后台静默会话（标题生成）', () => {
    it('silentMode 会话跳过 UI 激活，session_end 触发标题生成', async () => {
      const { plugin, titles, activated } = createSilentSessionPlugin()
      host.register(plugin)
      host.advancePhase()
      host.advancePhase()

      // 标题生成会话：silentMode = true，kind = title-generation
      const record = makeRecord('title-sess-1', 'claude', {
        silentMode: true,
        kind: 'title-generation',
      })
      const created = await host.dispatchBeforeCreateSession(record)
      expect(created).not.toBeNull()
      expect(activated.silentSkipped).toBe(1)
      expect(activated.normalActivated).toBe(0)

      // 会话开始 → 结束，触发标题生成
      await eventLog.append(makeEvent('conv-title', 'session_start', 'device-A', 1000))
      const running = await arbiter.getStatus('conv-title')
      await host.dispatchOnSessionStatusChange('conv-title', IDLE, running)

      await eventLog.append(
        makeEvent('conv-title', 'session_end', 'device-A', 5000, { reason: 'completed' }),
      )
      const done = await arbiter.getStatus('conv-title')
      await host.dispatchOnSessionStatusChange('conv-title', running, done)

      expect(titles).toEqual([{ conversationId: 'conv-title', text: '标题-conv-title' }])
    })

    it('beforeCreateSession 返回 null 阻止静默会话创建', async () => {
      const blocker: SessionPlugin = {
        id: 'blocker',
        beforeCreateSession(record) {
          // 无工作区不允许创建（复现 titleGenerationService 缺 workspace 时跳过）
          return record.workspaceId ? record : null
        },
      }
      host.register(blocker)
      host.advancePhase()
      host.advancePhase()

      const blocked = await host.dispatchBeforeCreateSession(
        makeRecord('sess-1', 'claude'),
      )
      expect(blocked).toBeNull()

      const allowed = await host.dispatchBeforeCreateSession(
        makeRecord('sess-2', 'claude', { workspaceId: 'ws-1' }),
      )
      expect(allowed).not.toBeNull()
    })
  })

  // ==========================================================================
  // 场景 3：调度器/派发任务
  // ==========================================================================

  describe('场景 3：调度器/派发任务', () => {
    it('session_end 时更新任务状态（成功/失败区分）', async () => {
      const { plugin, tasks } = createSchedulerPlugin()
      host.register(plugin)
      host.advancePhase()
      host.advancePhase()

      // 任务 1：正常完成
      await eventLog.append(makeEvent('sched-task-1', 'session_start', 'A', 1000))
      await eventLog.append(
        makeEvent('sched-task-1', 'session_end', 'A', 2000, { reason: 'completed' }),
      )
      const st1 = await arbiter.getStatus('sched-task-1')
      await host.dispatchOnSessionStatusChange(
        'sched-task-1',
        { ...IDLE, conversationId: 'sched-task-1', running: true, startedAt: 1000, startedByDevice: 'A' },
        st1,
      )

      // 任务 2：失败
      await eventLog.append(makeEvent('sched-task-2', 'session_start', 'A', 3000))
      await eventLog.append(
        makeEvent('sched-task-2', 'session_end', 'A', 4000, {
          reason: 'error',
          errorMessage: '模型超时',
        }),
      )
      const st2 = await arbiter.getStatus('sched-task-2')
      await host.dispatchOnSessionStatusChange(
        'sched-task-2',
        { ...IDLE, conversationId: 'sched-task-2', running: true, startedAt: 3000, startedByDevice: 'A' },
        st2,
      )

      expect(tasks).toContainEqual({ taskId: 'sched-task-1', status: 'done' })
      expect(tasks).toContainEqual({ taskId: 'sched-task-2', status: 'failed' })
    })
  })

  // ==========================================================================
  // 场景 4：历史恢复
  // ==========================================================================

  describe('场景 4：历史恢复', () => {
    it('恢复会话时设置 messageIds 引用', async () => {
      const { plugin, restored } = createHistoryRestorePlugin()
      host.register(plugin)
      host.advancePhase()
      host.advancePhase()

      const record = makeRecord('restore-sess-1', 'claude', {
        conversationId: 'conv-restored',
      })
      const created = await host.dispatchBeforeCreateSession(record)

      expect(created!.messageIds).toEqual(['hist-restore-sess-1-1', 'hist-restore-sess-1-2'])
      expect(restored).toHaveLength(1)

      // 恢复后消息可被读取（messageIds 已挂到会话）
      for (const id of created!.messageIds) {
        await messageLog.append(makeMsg(id, 'conv-restored', 'assistant', 1000, 'server'))
      }
      const msgs = await messageLog.read('conv-restored')
      expect(msgs).toHaveLength(2)
    })
  })

  // ==========================================================================
  // 场景 5：引擎层直接调用
  // ==========================================================================

  describe('场景 5：引擎层直接调用', () => {
    it('引擎回传 assistant 消息时注入 contextId 路由', async () => {
      const { plugin, routed } = createEngineDirectPlugin()
      host.register(plugin)
      host.advancePhase()
      host.advancePhase()

      // 引擎层直接 append assistant 消息（不经用户 UI 路径）
      const reply = makeMsg('A1', 'conv-eng', 'assistant', 2000, 'engine-node', {
        text: '回复内容',
      })
      const processed = await host.dispatchBeforeAppendMessage(reply)
      await messageLog.append(processed!)

      expect(processed!.content.contextId).toBe('ctx-conv-eng')
      expect(routed).toEqual(['conv-eng'])

      const msgs = await messageLog.read('conv-eng')
      expect(msgs[0].content.contextId).toBe('ctx-conv-eng')
    })
  })

  // ==========================================================================
  // 场景 6：isStreaming 消费方
  // ==========================================================================

  describe('场景 6：isStreaming 消费方', () => {
    it('running 变化触发 自动滚动 + TTS + 提交信息订阅', async () => {
      const { plugin, consumers } = createStreamingConsumerPlugin()
      host.register(plugin)
      host.advancePhase()
      host.advancePhase()

      // 会话开始 → 自动滚动 + TTS 触发
      await eventLog.append(makeEvent('conv-s', 'session_start', 'A', 1000))
      const running = await arbiter.getStatus('conv-s')
      await host.dispatchOnSessionStatusChange('conv-s', IDLE, running)
      expect(consumers.autoScroll).toBe(1)
      expect(consumers.tts).toBe(1)

      // 会话结束 → 提交信息订阅触发
      await eventLog.append(
        makeEvent('conv-s', 'session_end', 'A', 2000, { reason: 'completed' }),
      )
      const done = await arbiter.getStatus('conv-s')
      await host.dispatchOnSessionStatusChange('conv-s', running, done)
      expect(consumers.commitMsg).toBe(1)

      // 再次运行：消费方重复触发（复现 8 个消费方各自独立订阅）
      await eventLog.append(makeEvent('conv-s', 'session_start', 'A', 3000))
      const running2 = await arbiter.getStatus('conv-s')
      await host.dispatchOnSessionStatusChange('conv-s', done, running2)
      expect(consumers.autoScroll).toBe(2)
      expect(consumers.tts).toBe(2)
    })

    it('异步 hook 支持：await 异步消费方完成', async () => {
      let asyncDone = false
      const asyncPlugin: SessionPlugin = {
        id: 'async-consumer',
        async onSessionStatusChange() {
          await new Promise(resolve => setTimeout(resolve, 5))
          asyncDone = true
        },
      }
      host.register(asyncPlugin)
      host.advancePhase()
      host.advancePhase()

      await eventLog.append(makeEvent('conv-async', 'session_start', 'A', 1000))
      const status = await arbiter.getStatus('conv-async')
      await host.dispatchOnSessionStatusChange('conv-async', IDLE, status)

      expect(asyncDone).toBe(true)
    })
  })

  // ==========================================================================
  // 场景 7：仲裁策略可替换（扩展点 3）
  // ==========================================================================

  describe('扩展点 3：仲裁策略可替换', () => {
    it('beforeRequestStart 插件可注入自定义仲裁（拒绝特定设备）', async () => {
      // 协作模式：只允许发起方设备操作（复现 CollaborativeArbiter）
      const policy: SessionPlugin = {
        id: 'collab-policy',
        beforeRequestStart(_conversationId, deviceId) {
          return deviceId === 'master-device'
        },
      }
      host.register(policy)
      host.advancePhase()
      host.advancePhase()

      const denied = await host.dispatchBeforeRequestStart('conv-1', 'other-device')
      expect(denied).toBe(false)

      const allowed = await host.dispatchBeforeRequestStart('conv-1', 'master-device')
      expect(allowed).toBe(true)
    })
  })
})
