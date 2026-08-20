/**
 * EngineTestPanel — AI 引擎插件路径验证面板
 *
 * 功能：
 * - 引擎列表展示（原生/插件/engine-v1）
 * - 配置参数编辑
 * - 插件引擎注册测试
 * - 对话测试（事件流实时显示）
 * - 续聊测试
 * - 会话历史浏览
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useEngineMetadataStore } from '@/stores/engineMetadataStore'
import { invoke } from '@/services/transport'
import { createLogger } from '@/utils/logger'

const log = createLogger('EngineTestPanel')

// ==================== 类型 ====================

interface EventItem {
  id: number
  time: string
  type: string
  content: string
  isError?: boolean
  isDelta?: boolean
  toolName?: string
}

interface EngineTestStatus {
  connected: boolean
  elapsed: string
  inputTokens: number
  outputTokens: number
  toolCalls: number
  error: string | null
}

// ==================== 组件 ====================

export function EngineTestPanel({ pluginId: _pluginId }: { pluginId: string }) {
  const { metadatas, loaded, loading, error: metaError, load, reload } = useEngineMetadataStore()
  const [selectedEngine, setSelectedEngine] = useState<string>('')
  const [configModel, setConfigModel] = useState('deepseek-v4-flash')
  const [configWorkDir, setConfigWorkDir] = useState('')
  const [configPermissionMode, setConfigPermissionMode] = useState('auto')
  const [configSystemPrompt, setConfigSystemPrompt] = useState('')
  const [message, setMessage] = useState('')
  const [events, setEvents] = useState<EventItem[]>([])
  const [status, setStatus] = useState<EngineTestStatus>({
    connected: false, elapsed: '', inputTokens: 0, outputTokens: 0, toolCalls: 0, error: null,
  })
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [testAdapterJson, setTestAdapterJson] = useState('')
  const [registerResult, setRegisterResult] = useState<string | null>(null)
  const [registering, setRegistering] = useState(false)
  const [sending, setSending] = useState(false)
  const eventIdRef = useRef(0)
  const eventsEndRef = useRef<HTMLDivElement>(null)
  const startTimeRef = useRef<number>(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // 加载引擎元数据
  useEffect(() => {
    if (!loaded && !loading) load()
  }, [loaded, loading, load])

  // 默认选中第一个引擎
  useEffect(() => {
    if (metadatas.length > 0 && !selectedEngine) {
      setSelectedEngine(metadatas[0].id)
    }
  }, [metadatas, selectedEngine])

  // 自动滚动到底部
  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [events])

  // 计时器
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  const addEvent = useCallback((type: string, content: string, extra?: Partial<EventItem>) => {
    const now = new Date()
    const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`
    eventIdRef.current += 1
    setEvents(prev => [...prev, { id: eventIdRef.current, time, type, content, ...extra }])
  }, [])

  const getEngineDisplayName = (id: string) => {
    const meta = metadatas.find(m => m.id === id)
    return meta?.name ?? id
  }

  const getEngineBadge = (id: string): { label: string; className: string } => {
    const meta = metadatas.find(m => m.id === id)
    if (!meta) return { label: 'unknown', className: '' }
    // 根据 id 判断引擎类型
    if (id === 'claude-code' || id === 'codex' || id === 'pi' || id === 'dsh' || id === 'simple-ai') {
      return { label: 'Rust', className: 'badge-native' }
    }
    // 检查是否有 adapter 声明（通过插件系统注册的 Custom 引擎）
    // 简单启发：非已知 id 且不是 omp 的都是插件引擎
    if (id === 'omp') return { label: 'pi-rpc', className: 'badge-plugin' }
    return { label: 'engine-v1', className: 'badge-v1' }
  }

  // 注册测试适配器
  const handleRegisterTestAdapter = async () => {
    setRegistering(true)
    setRegisterResult(null)
    try {
      const engineConfig = JSON.parse(testAdapterJson || `{
        "id": "pi-test",
        "name": "Pi Test (engine-v1)",
        "description": "engine-v1 协议测试适配器",
        "cli": { "command": "node", "args": [] },
        "adapter": { "entry": "engine.mjs", "runtime": "node", "protocol": "engine-v1" },
        "capabilities": { "tools": true, "streaming": true, "interrupt": true, "resume": true }
      }`)
      await invoke('register_plugin_engine', { engine: engineConfig })
      setRegisterResult(`✅ 注册成功: ${engineConfig.id}`)
      addEvent('info', `插件引擎 ${engineConfig.id} 注册成功`)
      // 重新加载引擎列表
      await reload()
      setSelectedEngine(engineConfig.id)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setRegisterResult(`❌ 注册失败: ${msg}`)
      addEvent('error', `注册失败: ${msg}`)
    } finally {
      setRegistering(false)
    }
  }

  // 发送消息
  const handleSend = async () => {
    if (!message.trim() || !selectedEngine || sending) return

    setSending(true)
    setSessionId(null)
    setEvents([])
    setStatus({ connected: true, elapsed: '0s', inputTokens: 0, outputTokens: 0, toolCalls: 0, error: null })
    startTimeRef.current = Date.now()

    // 启动计时器
    timerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000)
      setStatus(prev => ({ ...prev, elapsed: `${elapsed}s` }))
    }, 1000)

    addEvent('cli_init', `启动 ${getEngineDisplayName(selectedEngine)}...`)

    try {
      const sid = await invoke<string>('start_chat', {
        engine: selectedEngine,
        message: message,
        workDir: configWorkDir || undefined,
        model: configModel || undefined,
        permissionMode: configPermissionMode || undefined,
        systemPrompt: configSystemPrompt || undefined,
      })
      setSessionId(sid)
      addEvent('session_start', `会话: ${sid.slice(0, 8)}...`)
      log.info(`会话已启动: ${sid}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      addEvent('error', `启动失败: ${msg}`)
      setStatus(prev => ({ ...prev, connected: false, error: msg }))
    } finally {
      setSending(false)
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }

  // 监听 AI 事件（通过 window 事件总线接收 start_chat 的事件流）
  useEffect(() => {
    const handler = (event: CustomEvent) => {
      const aiEvent = event.detail
      if (!aiEvent || !aiEvent.type) return

      const sessionIdMatch = aiEvent.session_id
      if (sessionIdMatch && sessionId && !sessionIdMatch.startsWith(sessionId.slice(0, 8))) return

      switch (aiEvent.type) {
        case 'token':
          addEvent('token', aiEvent.content, { isDelta: true })
          setStatus(prev => ({ ...prev, outputTokens: prev.outputTokens + 1 }))
          break
        case 'thinking':
          addEvent('thinking', aiEvent.content, { isDelta: true })
          break
        case 'assistant_message':
          addEvent('message', aiEvent.content?.slice(0, 500) || '(empty)')
          break
        case 'tool_call_start':
          addEvent('tool_call', `${aiEvent.tool} · ${JSON.stringify(aiEvent.args)}`, { toolName: aiEvent.tool })
          setStatus(prev => ({ ...prev, toolCalls: prev.toolCalls + 1 }))
          break
        case 'tool_call_end':
          addEvent('tool_result', `${aiEvent.success ? '✓' : '✗'} ${aiEvent.tool}`)
          break
        case 'usage':
          setStatus(prev => ({
            ...prev,
            inputTokens: aiEvent.input_tokens || prev.inputTokens,
            outputTokens: aiEvent.output_tokens || prev.outputTokens,
          }))
          addEvent('usage', `输入:${aiEvent.input_tokens || 0} 输出:${aiEvent.output_tokens || 0}`)
          break
        case 'error':
          addEvent('error', aiEvent.error || aiEvent.content || '未知错误', { isError: true })
          setStatus(prev => ({ ...prev, error: aiEvent.error || '未知错误' }))
          break
        case 'session_end':
          addEvent('session_end', `reason: ${aiEvent.reason || 'completed'}`)
          setStatus(prev => ({ ...prev, connected: false }))
          if (timerRef.current) clearInterval(timerRef.current)
          break
        case 'session_start':
          addEvent('session_start', `引擎: ${aiEvent.engine || '?'} 会话: ${aiEvent.session_id?.slice(0, 8) || '?'}`)
          break
        case 'cli_init':
          addEvent('cli_init', aiEvent.content || aiEvent.message || '引擎启动中...')
          break
        default:
          // 其他事件类型跳过
          break
      }
    }

    window.addEventListener('polaris:ai-event', handler as EventListener)
    return () => window.removeEventListener('polaris:ai-event', handler as EventListener)
  }, [sessionId, addEvent])

  // 中断
  const handleInterrupt = async () => {
    if (!sessionId) return
    try {
      await invoke('interrupt_chat', { sessionId })
      addEvent('info', '已发送中断请求')
    } catch (e) {
      addEvent('error', `中断失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 续聊
  const handleContinue = async () => {
    if (!message.trim() || !sessionId || sending) return
    setSending(true)
    try {
      await invoke('continue_chat', { sessionId, message })
      addEvent('session_start', `续聊: ${sessionId.slice(0, 8)}...`)
    } catch (e) {
      addEvent('error', `续聊失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSending(false)
    }
  }

  // 清除事件
  const handleClear = () => {
    setEvents([])
    setStatus({ connected: false, elapsed: '', inputTokens: 0, outputTokens: 0, toolCalls: 0, error: null })
    setSessionId(null)
  }

  // ==================== 渲染 ====================

  return (
    <div className="engine-test-panel">
      {/* 工具栏 */}
      <div className="et-toolbar">
        <span className="et-toolbar-title">引擎测试</span>
        <span className="et-toolbar-badge">engine-v1 · adapter</span>
      </div>

      <div className="et-content">
        {/* 左侧：引擎列表 + 配置 */}
        <div className="et-sidebar">
          {/* 引擎列表 */}
          <section className="et-section">
            <div className="et-section-title">
              🖥 引擎列表 <span className="et-count">{metadatas.length}</span>
            </div>
            {loading && <div className="et-hint">加载中...</div>}
            {metaError && <div className="et-error-text">加载失败: {metaError}</div>}
            <div className="et-engine-list">
              {metadatas.map(meta => {
                const badge = getEngineBadge(meta.id)
                const isSelected = selectedEngine === meta.id
                return (
                  <div
                    key={meta.id}
                    className={`et-engine-item ${isSelected ? 'selected' : ''}`}
                    onClick={() => setSelectedEngine(meta.id)}
                  >
                    <span className={`et-dot ${meta.distribution.type === 'custom-path' ? (meta.distribution.available ? 'available' : 'unavailable') : 'available'}`} />
                    <div className="et-engine-info">
                      <div className="et-engine-name">{meta.name}</div>
                      <div className="et-engine-meta">
                        <span className={`et-badge ${badge.className}`}>{badge.label}</span>
                        {meta.distribution.type === 'custom-path' && !meta.distribution.available && <span className="et-unavailable-text">未安装</span>}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>

          {/* 配置参数 */}
          <section className="et-section">
            <div className="et-section-title">⚙️ 配置参数</div>
            <div className="et-config">
              <div className="et-config-row">
                <label>模型</label>
                <input type="text" value={configModel} onChange={e => setConfigModel(e.target.value)} />
              </div>
              <div className="et-config-row">
                <label>工作目录</label>
                <input type="text" value={configWorkDir} onChange={e => setConfigWorkDir(e.target.value)} placeholder="可选" />
              </div>
              <div className="et-config-row">
                <label>权限模式</label>
                <select value={configPermissionMode} onChange={e => setConfigPermissionMode(e.target.value)}>
                  <option value="auto">auto</option>
                  <option value="bypassPermissions">bypassPermissions</option>
                  <option value="dontAsk">dontAsk</option>
                  <option value="plan">plan</option>
                </select>
              </div>
              <div className="et-config-row">
                <label>System</label>
                <textarea
                  value={configSystemPrompt}
                  onChange={e => setConfigSystemPrompt(e.target.value)}
                  placeholder="可选的系统提示词..."
                  rows={2}
                />
              </div>
              <div className="et-config-row">
                <label>引擎 ID</label>
                <input type="text" value={selectedEngine} disabled className="et-disabled-input" />
              </div>
            </div>
          </section>

          {/* 插件引擎注册测试 */}
          <section className="et-section">
            <div className="et-section-title">🔌 插件引擎注册</div>
            <div className="et-config">
              <div className="et-config-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <textarea
                  value={testAdapterJson}
                  onChange={e => setTestAdapterJson(e.target.value)}
                  placeholder={`粘贴引擎配置 JSON，或留空使用默认 pi-test 适配器配置`}
                  rows={3}
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}
                />
              </div>
              <button
                className="et-btn et-btn-primary"
                onClick={handleRegisterTestAdapter}
                disabled={registering}
                style={{ width: '100%', marginTop: 4 }}
              >
                {registering ? '注册中...' : '注册测试适配器'}
              </button>
              {registerResult && (
                <div className={`et-register-result ${registerResult.startsWith('✅') ? 'success' : 'error'}`}>
                  {registerResult}
                </div>
              )}
            </div>
          </section>
        </div>

        {/* 右侧：对话测试 */}
        <div className="et-chat-area">
          {/* 事件流 */}
          <div className="et-event-stream">
            {events.length === 0 && (
              <div className="et-empty-state">
                <div className="et-empty-icon">📡</div>
                <div className="et-empty-text">选择引擎，输入消息后发送</div>
                <div className="et-empty-hint">事件流将实时显示在此处</div>
              </div>
            )}
            {events.map(ev => (
              <div key={ev.id} className="et-event-item">
                <span className="et-event-time">{ev.time}</span>
                <span className="et-event-arrow">→</span>
                <span className={`et-event-type type-${ev.type}`}>
                  {ev.type === 'token' ? 'TOKEN' :
                   ev.type === 'thinking' ? 'THINKING' :
                   ev.type === 'message' ? 'ASSISTANT' :
                   ev.type === 'tool_call' ? 'TOOL_CALL' :
                   ev.type === 'tool_result' ? 'TOOL_RESULT' :
                   ev.type === 'usage' ? 'USAGE' :
                   ev.type === 'error' ? 'ERROR' :
                   ev.type === 'session_end' ? 'SESSION_END' :
                   ev.type === 'session_start' ? 'SESSION_START' :
                   ev.type === 'cli_init' ? 'CLI_INIT' :
                   ev.type === 'info' ? 'INFO' : ev.type.toUpperCase()}
                </span>
                <span className={`et-event-content ${ev.isError ? 'error' : ''} ${ev.type === 'thinking' ? 'thinking' : ''} ${ev.type === 'token' ? 'token' : ''}`}>
                  {ev.content}
                </span>
              </div>
            ))}
            <div ref={eventsEndRef} />
          </div>

          {/* 续聊区 */}
          <div className="et-continue-section">
            <div className="et-continue-row">
              <select
                value={sessionId || ''}
                onChange={e => setSessionId(e.target.value || null)}
                disabled={!sessionId}
              >
                {sessionId ? (
                  <option value={sessionId}>{sessionId.slice(0, 12)}... (当前会话)</option>
                ) : (
                  <option value="">发送消息后显示会话</option>
                )}
              </select>
              <span className="et-hint">选择要续聊的会话</span>
            </div>
          </div>

          {/* 输入区 */}
          <div className="et-input-area">
            <div className="et-input-row">
              <input
                type="text"
                value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder="输入消息，测试引擎..."
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) handleSend() }}
              />
              <button className="et-btn et-btn-primary" onClick={handleSend} disabled={sending || !selectedEngine}>
                发送
              </button>
              <button className="et-btn et-btn-secondary" onClick={handleInterrupt} disabled={!sessionId}>
                中断
              </button>
              <button className="et-btn et-btn-success" onClick={handleContinue} disabled={sending || !sessionId}>
                续聊
              </button>
              <button className="et-btn et-btn-danger" onClick={handleClear}>
                清除
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 状态栏 */}
      <div className="et-status-bar">
        <span className={`et-status-dot ${status.connected ? 'connected' : status.error ? 'error' : 'idle'}`} />
        <span>{selectedEngine ? getEngineDisplayName(selectedEngine) : '未选择'}</span>
        <span className="et-spacer" />
        {status.elapsed && <span className="et-stat">⏱ {status.elapsed}</span>}
        {(status.inputTokens > 0 || status.outputTokens > 0) && (
          <span className="et-stat">📊 {status.inputTokens}/{status.outputTokens} tokens</span>
        )}
        {status.toolCalls > 0 && <span className="et-stat">🔧 {status.toolCalls} calls</span>}
        {status.connected && <span className="et-stat">✓ 已连接</span>}
        {status.error && <span className="et-stat et-error-text">✗ {status.error}</span>}
      </div>
    </div>
  )
}