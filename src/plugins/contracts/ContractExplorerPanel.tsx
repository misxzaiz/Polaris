/**
 * 契约测试/管理面板（重构第一步 — 契约冻结 的"活仪表盘"）
 *
 * 阶段 A：纯前端面板，不接后端。
 * - 契约清单：展示 6+1 核心 trait + Bootstrap 直管 trait 的结构化说明
 * - Envelope/Source roundtrip 测试台：可视化序列化→反序列化→比对
 *
 * 阶段 B（第 3 步 RouterBus 实现后）：接已注册能力表 / 依赖图 / 事件追踪。
 */

import { useState } from 'react'
import { CheckCircle2, Circle, Play, RotateCcw, TerminalSquare, GitBranch, Boxes, Database, Plug, ShieldCheck, CalendarClock, Layers } from 'lucide-react'
import { createLogger } from '@/utils/logger'

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
    setEnv((e) => ({ ...e, source: sourcePresets[idx]!.make() }))
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
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <SourceSemantics />
      <EnvelopeTestBench />
      <TraitCatalog />
    </div>
  )
}