/**
 * 契约测试/管理面板（重构第一步 — 契约冻结 的"活仪表盘"）
 *
 * 阶段 A：纯前端面板，不接后端。
 * - 契约清单：展示 6+1 核心 trait + Bootstrap 直管 trait 的结构化说明
 * - Envelope/Source roundtrip 测试台：可视化序列化→反序列化→比对
 *
 * 阶段 C（RouterBus 接线后）：接已注册能力列表 + dispatch 测试台。
 * - 已注册能力列表：调 `router_list_caps`，点选可直接填入测试台
 * - dispatch 测试台：选能力 → 填 payload → 经统一总线 dispatch →
 *   看 Reply（ok / result / error / trace）
 *
 * 桌面端走 Tauri IPC，Web/HTTP 端走 `/api/router-*`（统一 `invoke` 自动适配）。
 */

import { useEffect, useState } from 'react'
import { CheckCircle2, Circle, Play, RotateCcw, TerminalSquare, GitBranch, Boxes, Database, Plug, ShieldCheck, CalendarClock, Layers, RefreshCw, XCircle } from 'lucide-react'
import { createLogger } from '@/utils/logger'
import { invoke } from '@/services/transport'

const log = createLogger('ContractExplorerPanel')

/** lucide icon 名 → 组件映射（activityBar icon 用字面量，这里面板内容用组件） */
const iconMap = {
  TerminalSquare,
  GitBranch,
  Boxes,
  Database,
  Plug,
  Play,
  ShieldCheck,
  CalendarClock,
  Layers,
} as const

/* ============================================================================
 * 契约清单（与 src-tauri/src/contracts/mod.rs 一一对应，静态说明）
 * ============================================================================ */

interface TraitInfo {
  name: string
  kind: 'trait' | 'bootstrap-trait'
  desc: string
  methods: string[]
  icon: keyof typeof iconMap
}

const traitCatalog: TraitInfo[] = [
  {
    name: 'Context',
    kind: 'trait',
    desc: '由 Bootstrap 注入实现，插件只依赖 trait。签名不返回 Arc/Rc，所有返回值可跨 WASM 序列化。',
    methods: ['resolve_cap', 'storage', 'check_permission', 'source', 'caller_id', 'plugin_config'],
    icon: 'Boxes',
  },
  {
    name: 'Plugin',
    kind: 'trait',
    desc: '插件（实现契约的可替换单元）。依赖权威源 = manifest requires（单源）。',
    methods: ['init', 'name', 'version', 'capabilities', 'required_permissions', 'shutdown'],
    icon: 'Layers',
  },
  {
    name: 'Capability',
    kind: 'trait',
    desc: '能力（插件提供的一个可调用单元）。路由键是能力 id，不是插件名。',
    methods: ['id', 'invoke', 'dependencies', 'drain'],
    icon: 'Plug',
  },
  {
    name: 'StreamingCapability',
    kind: 'trait',
    desc: '流式能力（可选 trait）。返回 Receiver<Event>，逐 token 广播。',
    methods: ['invoke_stream'],
    icon: 'Play',
  },
  {
    name: 'Storage',
    kind: 'trait',
    desc: '统一持久化（插件可替换后端）。FTS5 可丢弃可重建，审计内嵌各域 DB。',
    methods: ['root', 'store', 'load', 'query', 'delete', 'begin'],
    icon: 'Database',
  },
  {
    name: 'Router',
    kind: 'trait',
    desc: '转发骨干（一条总线）。取消 invoke，所有调用一律走 dispatch。',
    methods: ['dispatch', 'subscribe', 'register_handle'],
    icon: 'GitBranch',
  },
  {
    name: 'Permission',
    kind: 'trait',
    desc: '权限裁决。静态授权 = 装配时校验；动态授权 = 用户审批。',
    methods: ['check'],
    icon: 'ShieldCheck',
  },
  {
    name: 'Session',
    kind: 'trait',
    desc: '会话生命周期（引擎无关）。on_orphan/grace_timeout 用于进程生命周期。',
    methods: ['start', 'end', 'on_orphan', 'grace_timeout'],
    icon: 'CalendarClock',
  },
  {
    name: 'Scheduler',
    kind: 'trait',
    desc: '任务调度。',
    methods: ['schedule', 'cancel'],
    icon: 'CalendarClock',
  },
  {
    name: 'AuditSink',
    kind: 'bootstrap-trait',
    desc: 'Bootstrap 直管。仅追加 O_APPEND，每条含前条哈希形成 tamper-evident 链。',
    methods: ['append'],
    icon: 'Boxes',
  },
  {
    name: 'LocalSecretProvider',
    kind: 'bootstrap-trait',
    desc: 'Bootstrap 直管。Core 启动生成一次性 secret，经非 HTTP 通道传给本地 Shell。',
    methods: ['generate', 'verify'],
    icon: 'ShieldCheck',
  },
]

/* ============================================================================
 * Envelope / Source roundtrip 测试台
 * （前端同构类型，模拟 Rust 侧的 serde roundtrip）
 * ============================================================================ */

type Source =
  | { kind: 'Bootstrap' }
  | { kind: 'Remote'; token: string }
  | { kind: 'Plugin'; caller: string }

interface EnvelopeShape {
  id: string
  source: Source
  target: string
  payload: Record<string, unknown>
  trace: string
}

/** 生成一个默认 Envelope（对应 Rust 侧测试用例） */
function makeEnvelope(over: Partial<EnvelopeShape> = {}): EnvelopeShape {
  return {
    id: 'msg-1',
    source: { kind: 'Plugin', caller: 'cap.ai' },
    target: 'cap.kv',
    payload: { key: 'foo', value: 42 },
    trace: 'trace-1',
    ...over,
  }
}

/** 序列化（模拟 serde_json::to_string） */
function serialize(env: EnvelopeShape): string {
  return JSON.stringify(env)
}

/** 反序列化（模拟 serde_json::from_str） */
function deserialize(s: string): EnvelopeShape {
  return JSON.parse(s)
}

/** roundtrip 校验：序列化 → 反序列化 → 深度比对 */
function roundtrip(env: EnvelopeShape): { ok: boolean; serialized: string; equal: boolean; detail: string } {
  const serialized = serialize(env)
  const back = deserialize(serialized)
  const equal = JSON.stringify(back) === JSON.stringify(env)
  return {
    ok: equal,
    serialized,
    equal,
    detail: equal ? '✅ 往返一致' : '❌ 往返不一致（数据损坏）',
  }
}

const sourcePresets: { label: string; desc: string; make: () => Source }[] = [
  { label: 'Bootstrap', desc: 'Core 内部调用，Shell 永不获得', make: () => ({ kind: 'Bootstrap' as const }) },
  { label: 'Remote', desc: 'HTTP/WS，必须携带有效 token', make: () => ({ kind: 'Remote' as const, token: 'tok-123' }) },
  { label: 'Plugin', desc: '插件间调用，caller 由 ctx 注入', make: () => ({ kind: 'Plugin' as const, caller: 'cap.ai' }) },
]

/* ============================================================================
 * 阶段 C：已注册能力列表 + dispatch 测试台
 * 后端：router_list_caps / router_dispatch（桌面 Tauri IPC / Web HTTP 统一 invoke）
 * ============================================================================ */

interface CapabilityInfo {
  id: string
}

/** 演示/链路验证能力（非真实业务域，见 step4-migration.md §5） */
const DEMO_CAPS = new Set(['cap.kv', 'cap.echo', 'cap.faulty'])

interface DispatchReply {
  msgId: string
  ok: boolean
  result: Record<string, unknown> | null
  error: string | null
  trace: string
}

/** 已注册能力列表（点击直接填入测试台） */
function CapabilityList({ onSelect }: { onSelect: (id: string) => void }) {
  const [caps, setCaps] = useState<CapabilityInfo[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = async () => {
    setLoading(true)
    try {
      const list = await invoke<CapabilityInfo[]>('router_list_caps')
      setCaps(Array.isArray(list) ? list : [])
    } catch (e) {
      log.error('router_list_caps 失败', e instanceof Error ? e : undefined)
      setCaps([])
    } finally {
      setLoading(false)
    }
  }

  // 首次挂载拉一次
  useEffect(() => {
    void refresh()
  }, [])

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] p-4">
      <div className="flex items-center gap-2">
        <Plug size={16} />
        <span className="text-sm font-medium">已注册能力</span>
        <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] text-blue-500">
          {caps.length}
        </span>
        <button
          className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
          onClick={() => void refresh()}
          title="刷新"
          disabled={loading}
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> 刷新
        </button>
      </div>

      {caps.length === 0 ? (
        <p className="text-[11px] text-[var(--color-text-secondary)]">
          尚未加载到能力（RouterBus 未接线，或后端不可达）。点击刷新重试。
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {caps.map((c) => (
            <button
              key={c.id}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono text-[11px] text-[var(--color-text)] transition-colors hover:border-blue-500/50 hover:bg-blue-500/5"
              onClick={() => onSelect(c.id)}
              title={`点击填入 dispatch 测试台`}
            >
              {c.id}
              {DEMO_CAPS.has(c.id) && (
                <span className="ml-1 rounded bg-amber-500/10 px-1 py-px text-[9px] text-amber-500">demo</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** dispatch 测试台（经统一总线真实调用后端能力） */
function DispatchTestBench({
  selectTarget,
}: {
  /** 外部（能力列表点选）注入的目标能力 id —— 每次变化会让测试台跟随 */
  selectTarget?: string | null
}) {
  const [caps, setCaps] = useState<CapabilityInfo[]>([])
  const [target, setTarget] = useState('cap.kv')
  const [payloadText, setPayloadText] = useState('{\n  "action": "list"\n}')
  const [loading, setLoading] = useState(false)
  const [reply, setReply] = useState<DispatchReply | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // 外部点选能力 → 同步测试台
  useEffect(() => {
    if (!selectTarget) return
    setTarget(selectTarget)
    if (selectTarget === 'cap.kv') {
      setPayloadText('{\n  "action": "get",\n  "key": "greeting"\n}')
    }
  }, [selectTarget])

  // 加载能力列表做下拉
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await invoke<CapabilityInfo[]>('router_list_caps')
        if (!cancelled) setCaps(Array.isArray(list) ? list : [])
      } catch (e) {
        if (!cancelled) log.error('router_list_caps 失败', e instanceof Error ? e : undefined)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const run = async () => {
    setLoading(true)
    setErr(null)
    try {
      let payload: unknown
      try {
        payload = JSON.parse(payloadText)
      } catch (e) {
        setErr(`payload 不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`)
        return
      }
      const res = await invoke<DispatchReply>('router_dispatch', {
        req: { target, payload },
      })
      setReply(res)
    } catch (e) {
      setErr(`dispatch 调用失败: ${e instanceof Error ? e.message : String(e)}`)
      setReply(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] p-4">
      <div className="flex items-center gap-2">
        <TerminalSquare size={16} />
        <span className="text-sm font-medium">dispatch 测试台</span>
        <button
          className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
          onClick={() => {
            setTarget('cap.kv')
            setPayloadText('{\n  "action": "list"\n}')
            setReply(null)
            setErr(null)
          }}
          title="重置"
        >
          <RotateCcw size={12} /> 重置
        </button>
      </div>

      {/* 目标能力 + 来源 */}
      <div className="grid grid-cols-2 gap-3 text-xs">
        <label className="flex flex-col gap-1">
          <span className="text-[var(--color-text-secondary)]">目标能力（cap id）</span>
          <div className="flex gap-1.5">
            <input
              className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono outline-none focus:border-blue-500"
              value={target}
              list="cap-datalist"
              onChange={(e) => setTarget(e.target.value)}
              placeholder="如 cap.kv"
            />
            <datalist id="cap-datalist">
              {caps.map((c) => (
                <option key={c.id} value={c.id} />
              ))}
            </datalist>
            <span
              className="flex items-center rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[10px] text-[var(--color-text-secondary)]"
              title="来源由后端按调用通道判定（第五步阶段 A）：桌面主窗口 = Bootstrap；Web/HTTP = Remote"
            >
              来源：后端判定
            </span>
          </div>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[var(--color-text-secondary)]">说明</span>
          <div className="flex h-full items-center rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)]">
            Source 由传输层注入、调用方不可自填（契约铁律）：桌面主窗口 = Bootstrap，Web/HTTP 与内置浏览器 = Remote。前端自报来源已被后端忽略。
          </div>
        </label>
      </div>

      {/* payload JSON */}
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-[var(--color-text-secondary)]">payload (JSON)</span>
        <textarea
          className="min-h-[80px] resize-y rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono text-[11px] outline-none focus:border-blue-500"
          value={payloadText}
          onChange={(e) => setPayloadText(e.target.value)}
          placeholder='{"action": "list"}'
        />
      </label>

      {/* 运行 */}
      <button
        className="flex items-center justify-center gap-2 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => void run()}
        disabled={loading}
      >
        <Play size={12} /> {loading ? 'dispatch 进行中…' : '运行 dispatch'}
      </button>

      {/* 错误 */}
      {err && (
        <div className="flex items-start gap-1.5 rounded border border-red-500/30 bg-red-500/5 p-3 text-xs">
          <XCircle size={14} className="mt-0.5 shrink-0 text-red-500" />
          <div className="break-all font-mono text-[11px] text-red-500">{err}</div>
        </div>
      )}

      {/* 结果 */}
      {reply && (
        <div className={`rounded border p-3 text-xs ${reply.ok ? 'border-green-500/30 bg-green-500/5' : 'border-amber-500/30 bg-amber-500/5'}`}>
          <div className="mb-1 flex items-center gap-1.5">
            {reply.ok
              ? <CheckCircle2 size={14} className="text-green-500" />
              : <Circle size={14} className="text-amber-500" />}
            <span className={reply.ok ? 'text-green-500' : 'text-amber-500'}>
              {reply.ok ? '✅ ok' : '❌ rejected / error'}
            </span>
            <span className="ml-auto font-mono text-[10px] text-[var(--color-text-secondary)]">
              {reply.msgId} · trace {reply.trace}
            </span>
          </div>
          <div className="mt-1 break-all whitespace-pre-wrap rounded bg-[var(--color-surface)] p-2 font-mono text-[10px] text-[var(--color-text)]">
            {reply.ok
              ? JSON.stringify(reply.result, null, 2)
              : `error: ${reply.error ?? '(unknown)'}`}
          </div>
        </div>
      )}
    </div>
  )
}

/** Source 语义卡（核心：无 local 变体） */
function SourceSemantics() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] p-4">
      <div className="flex items-center gap-2">
        <ShieldCheck size={16} />
        <span className="text-sm font-medium">Source 语义</span>
        <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] text-blue-500">无 local 变体</span>
      </div>
      <div className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
        <p className="mb-2">
          <span className="text-[var(--color-text)]">铁律：</span>
          Source 枚举<strong className="text-red-500">没有</strong> local 变体——本地 Shell 永不获得 Source::Local。
          本地身份由 Bootstrap 经非 HTTP 通道（环境变量）注入的 LocalSecret 证明。这从类型层面杜绝
          "本地授权沾光远程"漏洞。
        </p>
        <div className="grid grid-cols-3 gap-2">
          {sourcePresets.map((p) => (
            <div key={p.label} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
              <div className="mb-1 font-mono text-xs">{p.label}</div>
              <div className="text-[11px] text-[var(--color-text-secondary)]">{p.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Envelope roundtrip 测试台 */
function EnvelopeTestBench() {
  const [sourceIdx, setSourceIdx] = useState(0)
  const [env, setEnv] = useState<EnvelopeShape>(() => makeEnvelope())
  const [result, setResult] = useState<{ ok: boolean; serialized: string; equal: boolean; detail: string } | null>(null)

  const run = () => {
    const r = roundtrip(env)
    setResult(r)
  }

  const selectSource = (idx: number) => {
    setSourceIdx(idx)
    const preset = sourcePresets[idx]
    if (preset) setEnv((e) => ({ ...e, source: preset.make() }))
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] p-4">
      <div className="flex items-center gap-2">
        <TerminalSquare size={16} />
        <span className="text-sm font-medium">Envelope roundtrip 测试台</span>
        <button
          className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
          onClick={() => {
            const fresh = makeEnvelope()
            setEnv(fresh)
            setResult(null)
            setSourceIdx(0)
          }}
          title="重置"
        >
          <RotateCcw size={12} /> 重置
        </button>
      </div>

      {/* 字段编辑 */}
      <div className="grid grid-cols-2 gap-3 text-xs">
        <label className="flex flex-col gap-1">
          <span className="text-[var(--color-text-secondary)]">id</span>
          <input
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono outline-none focus:border-blue-500"
            value={env.id}
            onChange={(e) => setEnv((v) => ({ ...v, id: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[var(--color-text-secondary)]">target (能力 id)</span>
          <input
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono outline-none focus:border-blue-500"
            value={env.target}
            onChange={(e) => setEnv((v) => ({ ...v, target: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[var(--color-text-secondary)]">trace</span>
          <input
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono outline-none focus:border-blue-500"
            value={env.trace}
            onChange={(e) => setEnv((v) => ({ ...v, trace: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[var(--color-text-secondary)]">source</span>
          <select
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 outline-none focus:border-blue-500"
            value={sourceIdx}
            onChange={(e) => selectSource(Number(e.target.value))}
          >
            {sourcePresets.map((p, i) => (
              <option key={p.label} value={i}>{p.label}</option>
            ))}
          </select>
        </label>
      </div>

      {/* payload 编辑（JSON） */}
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-[var(--color-text-secondary)]">payload (JSON)</span>
        <textarea
          className="min-h-[72px] resize-y rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono text-[11px] outline-none focus:border-blue-500"
          value={JSON.stringify(env.payload, null, 2)}
          onChange={(e) => {
            const v = e.target.value
            try {
              setEnv((prev) => ({ ...prev, payload: JSON.parse(v) }))
            } catch {
              log.info('payload JSON 暂存不改（解析失败）')
            }
          }}
        />
      </label>

      {/* 运行 */}
      <button
        className="flex items-center justify-center gap-2 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
        onClick={run}
      >
        <Play size={12} /> 运行 roundtrip
      </button>

      {/* 结果 */}
      {result && (
        <div className={`rounded border p-3 text-xs ${result.ok ? 'border-green-500/30 bg-green-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
          <div className="mb-1 flex items-center gap-1.5">
            {result.ok ? <CheckCircle2 size={14} className="text-green-500" /> : <Circle size={14} className="text-red-500" />}
            <span className={result.ok ? 'text-green-500' : 'text-red-500'}>{result.detail}</span>
          </div>
          <div className="mt-1 break-all font-mono text-[10px] text-[var(--color-text-secondary)]">{result.serialized}</div>
        </div>
      )}
    </div>
  )
}

/** 审计链视图（第五步阶段 B：dispatch 审计落盘 <DataRoot>/audit/dispatch.jsonl） */
interface AuditVerifyReply {
  ok: boolean
  brokenLine: number | null
  total: number
}

function AuditChainView() {
  const [lines, setLines] = useState<string[]>([])
  const [total, setTotal] = useState(0)
  const [verify, setVerify] = useState<AuditVerifyReply | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const refresh = async () => {
    setLoading(true)
    setErr(null)
    try {
      const tail = await invoke<{ lines: string[]; total: number }>('audit_tail', { count: 12 })
      setLines(Array.isArray(tail?.lines) ? tail.lines : [])
      setTotal(tail?.total ?? 0)
      const v = await invoke<AuditVerifyReply>('audit_verify')
      setVerify(v)
    } catch (e) {
      setErr(`审计读取失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] p-4">
      <div className="flex items-center gap-2">
        <Boxes size={16} />
        <span className="text-sm font-medium">审计链（dispatch.jsonl）</span>
        <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] text-blue-500">
          共 {total} 条
        </span>
        {verify && (
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] ${
              verify.ok
                ? 'bg-green-500/10 text-green-500'
                : 'bg-red-500/10 text-red-500'
            }`}
            title={verify.ok ? 'sha256 链逐条校验通过' : `第 ${verify.brokenLine} 行被篡改`}
          >
            {verify.ok ? '✅ 链完整' : `❌ 第 ${verify.brokenLine} 行被篡改`}
          </span>
        )}
        <button
          className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
          onClick={() => void refresh()}
          title="刷新（读取尾部 12 条 + 全链校验）"
          disabled={loading}
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> 刷新
        </button>
      </div>

      {err && (
        <div className="break-all rounded border border-red-500/30 bg-red-500/5 p-2 font-mono text-[11px] text-red-500">
          {err}
        </div>
      )}

      {lines.length === 0 && !err ? (
        <p className="text-[11px] text-[var(--color-text-secondary)]">
          暂无审计记录。经 dispatch 面板或待办面板发起一次调用后，这里会出现
          dispatch.start/end 与 deny 轨迹（tamper-evident 哈希链）。
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {lines.map((line, i) => {
            let action = ''
            let cap = ''
            let ts = ''
            try {
              const parsed = JSON.parse(line) as { action?: string; capability?: string; timestampMs?: number }
              action = parsed.action ?? ''
              cap = parsed.capability ?? ''
              ts = parsed.timestampMs ? new Date(parsed.timestampMs).toLocaleTimeString() : ''
            } catch {
              action = '(无法解析)'
            }
            const deny = action.includes('deny')
            return (
              <div
                key={i}
                className={`flex items-center gap-2 rounded border px-2 py-1 font-mono text-[10px] ${
                  deny
                    ? 'border-red-500/30 bg-red-500/5 text-red-500'
                    : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)]'
                }`}
              >
                <span>{ts}</span>
                <span className="text-[var(--color-text)]">{cap}</span>
                <span className="truncate">{action}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 契约清单卡片 */
function TraitCatalog() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] p-4">
      <div className="flex items-center gap-2">
        <Layers size={16} />
        <span className="text-sm font-medium">核心契约清单（6+1 + Bootstrap 直管）</span>
      </div>
      <div className="flex flex-col gap-2">
        {traitCatalog.map((t) => {
          const Icon = iconMap[t.icon]
          return (
            <div key={t.name} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5">
              <div className="mb-1 flex items-center gap-2">
                <Icon size={13} />
                <span className="font-mono text-xs">{t.name}</span>
                {t.kind === 'bootstrap-trait' && (
                  <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-500">Bootstrap 直管</span>
                )}
              </div>
              <p className="mb-1.5 text-[11px] text-[var(--color-text-secondary)]">{t.desc}</p>
              <div className="flex flex-wrap gap-1">
                {t.methods.map((m) => (
                  <span key={m} className="rounded bg-[var(--color-surface-hover)] px-1.5 py-0.5 font-mono text-[10px]">{m}</span>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 面板主组件 */
export default function ContractExplorerPanel() {
  // 共享"点选能力"状态：能力列表点选 → 联动 dispatch 测试台
  const [selectedCap, setSelectedCap] = useState<string | null>(null)

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <DispatchTestBench selectTarget={selectedCap} />
      <CapabilityList onSelect={setSelectedCap} />
      <AuditChainView />
      <SourceSemantics />
      <EnvelopeTestBench />
      <TraitCatalog />
    </div>
  )
}