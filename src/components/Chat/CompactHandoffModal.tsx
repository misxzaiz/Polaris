/**
 * CompactHandoffModal - 压缩交接面板
 *
 * 一键把当前会话「压缩成结构化简报，并在新会话继续」。面板只问最少的必要选项：
 * - 压缩引擎 / 服务供应商(Profile) / 模型：用哪个 AI 引擎、什么线路来压缩
 * - 压缩要求：预填结构化模板，可编辑
 * - 新会话引擎：压缩后新会话用哪个 AI 引擎继续
 *
 * 三个引擎角色：源会话（被压缩）/ 压缩引擎（静默执行）/ 新会话引擎（继续工作），
 * 压缩引擎与新会话引擎均可独立选择。执行编排见 services/contextCompactHandoff.ts。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, X, ChevronDown, Bot, Cpu, Zap, Sparkles } from 'lucide-react'
import { clsx } from 'clsx'
import { useModelProfileStore } from '@/stores/modelProfileStore'
import { isProfileForEngine } from '@/types/modelProfile'
import { normalizeEngineId, getEngineFullName } from '@/utils/engineDisplay'
import { useToastStore } from '@/stores/toastStore'
import { getDefaultCompactInstruction } from '@/services/contextCompactHandoff'
import { useCompactHandoffStore } from '@/stores/compactHandoffStore'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import { getSessionConfig } from '@/stores/sessionConfigStore'
import { resolveEffectiveProfileId } from '@/stores/conversationStore/conversationStoreUtils'
import type { EngineId } from '@/types'

interface CompactHandoffModalProps {
  /** 源会话 ID */
  sessionId: string
  /** 源会话标题 */
  sessionTitle: string
  /** 源会话引擎（作为压缩/新会话引擎的默认值） */
  engineId: string
  onClose: () => void
}

interface SelectOption {
  value: string
  label: string
  description?: string
}

/** AI 引擎选项（与 NewSessionButton 保持一致） */
const ENGINE_OPTIONS: Array<{ id: EngineId; label: string; Icon: typeof Bot }> = [
  { id: 'claude-code', label: 'Claude', Icon: Bot },
  { id: 'codex', label: 'Codex', Icon: Cpu },
  { id: 'simple-ai', label: 'Simple', Icon: Zap },
  { id: 'mimo', label: 'Mimo', Icon: Sparkles },
]

/** 将引擎 id 映射到 Profile 过滤用的引擎类别 */
function toProfileEngine(engineId: string): 'claude' | 'codex' | 'simple-ai' | 'mimo' {
  const e = normalizeEngineId(engineId)
  return e === 'codex' ? 'codex' : e === 'simple-ai' ? 'simple-ai' : e === 'mimo' ? 'mimo' : 'claude'
}

/** 引擎单选段（图标 + 名称，四选一横向排列） */
function EnginePicker({
  value,
  onChange,
  disabled,
}: {
  value: EngineId
  onChange: (id: EngineId) => void
  disabled?: boolean
}) {
  return (
    <div className="grid grid-cols-4 gap-1">
      {ENGINE_OPTIONS.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          disabled={disabled}
          onClick={() => onChange(id)}
          title={getEngineFullName(id)}
          className={clsx(
            'flex flex-col items-center justify-center gap-1 px-1 py-2 rounded-md text-[11px] transition-colors border',
            disabled && 'opacity-50 cursor-not-allowed',
            value === id
              ? 'bg-primary/10 text-primary border-primary/30'
              : 'text-text-secondary hover:text-text-primary hover:bg-background-hover border-border-subtle',
          )}
        >
          <Icon size={15} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  )
}

/** 极简下拉：受控值 + 选项，无外部依赖 */
function Dropdown({
  value,
  options,
  placeholder,
  onChange,
  disabled,
}: {
  value: string
  options: SelectOption[]
  placeholder: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  const current = options.find((o) => o.value === value)

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          'w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-sm',
          'bg-background-surface border border-border',
          disabled ? 'opacity-50 cursor-not-allowed' : 'hover:border-primary/50',
        )}
      >
        <span className={clsx('truncate', !current && 'text-text-tertiary')}>
          {current?.label ?? placeholder}
        </span>
        <ChevronDown size={14} className="opacity-50 shrink-0" />
      </button>
      {open && !disabled && (
        <div className="absolute top-full left-0 right-0 mt-1 z-50 max-h-[220px] overflow-y-auto bg-background-elevated border border-border rounded-lg shadow-lg">
          {options.length === 0 && (
            <div className="px-3 py-2 text-xs text-text-tertiary">—</div>
          )}
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
              className={clsx(
                'w-full px-3 py-2 text-left text-xs hover:bg-background-hover flex flex-col gap-0.5',
                value === o.value && 'bg-primary/10 text-primary',
              )}
            >
              <span className="font-medium truncate">{o.label}</span>
              {o.description && (
                <span className="text-text-tertiary text-[10px] truncate">{o.description}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function CompactHandoffModal({
  sessionId,
  sessionTitle,
  engineId,
  onClose,
}: CompactHandoffModalProps) {
  const { t } = useTranslation('chat')
  const sourceEngine = normalizeEngineId(engineId)

  const profiles = useModelProfileStore((s) => s.profiles)

  // 源会话当前生效的供应商(Profile)与模型：作为压缩配置默认值，
  // 让「压缩」默认沿用你当前对话正在用的线路，无需重复挑选。
  // 解析链与 sendMessage 一致：会话级覆盖 > 状态栏镜像 > 全局激活 Profile。
  const sourceDefaults = useMemo(() => {
    const meta = sessionStoreManager.getState().sessionMetadata.get(sessionId)
    const sessionConfig = getSessionConfig()
    const activeProfileId = useModelProfileStore.getState().activeProfileId ?? undefined
    const profileId = resolveEffectiveProfileId(
      meta?.modelProfileId,
      sessionConfig.modelProfileId,
      activeProfileId,
    ) ?? '' // undefined = 官方 API = 空
    const model = meta?.model || sessionConfig.model || ''
    return { profileId, model }
    // sessionId 变化才重算（同一 modal 生命周期内源会话固定）
  }, [sessionId])

  // 表单状态：引擎默认沿用源会话引擎；供应商/模型默认沿用源会话当前线路
  const [compactEngine, setCompactEngine] = useState<EngineId>(sourceEngine)
  const [compactProfileId, setCompactProfileId] = useState(sourceDefaults.profileId)
  const [compactModel, setCompactModel] = useState(sourceDefaults.model)
  const [instruction, setInstruction] = useState(() => getDefaultCompactInstruction())
  const [newEngine, setNewEngine] = useState<EngineId>(sourceEngine)
  const [showInstruction, setShowInstruction] = useState(false)

  // 供应商选项：按压缩引擎过滤（切换引擎时清空已选 Profile/模型）
  const profileOptions = useMemo<SelectOption[]>(
    () => [
      { value: '', label: t('sessionConfig.officialApi'), description: t('sessionConfig.officialApiDesc') },
      ...profiles
        .filter((p) => isProfileForEngine(p, toProfileEngine(compactEngine)))
        .map((p) => ({ value: p.id, label: p.name, description: p.baseUrl })),
    ],
    [profiles, compactEngine, t],
  )

  const modelOptions = useMemo<SelectOption[]>(() => {
    const profile = profiles.find((p) => p.id === compactProfileId)
    const base = profile
      ? (profile.modelOptions?.length ? profile.modelOptions : [profile.model]).filter(Boolean)
      : []
    const set = new Set(base)
    // 保证预选/自定义模型始终可见（源会话模型可能不在 Profile 列表内）
    if (compactModel) set.add(compactModel)
    return [...set].map((m) => ({ value: m, label: m }))
  }, [profiles, compactProfileId, compactModel])

  const handleStart = () => {
    const started = useCompactHandoffStore.getState().start({
      sessionId,
      sourceTitle: sessionTitle,
      compact: {
        engineId: compactEngine,
        modelProfileId: compactProfileId || undefined,
        model: compactModel || undefined,
        instruction: instruction.trim() || getDefaultCompactInstruction(),
      },
      newSession: { engineId: newEngine },
    })
    if (started) {
      // 触发即走：面板关闭，压缩在后台进行，用户可继续查看其他对话
      useToastStore.getState().info(
        t('compactHandoff.startedToast'),
        t('compactHandoff.startedToastHint'),
      )
      onClose()
    }
  }

  const handleCancel = () => onClose()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-background-elevated rounded-xl shadow-2xl border border-border w-[440px] max-w-[92vw] max-h-[88vh] flex flex-col">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Archive className="w-5 h-5 text-primary" />
            <h2 className="text-base font-semibold text-text-primary">{t('compactHandoff.title')}</h2>
          </div>
          <button
            onClick={handleCancel}
            className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 内容 */}
        <div className="px-5 py-4 overflow-y-auto flex flex-col gap-4">
          <p className="text-xs text-text-tertiary leading-relaxed">
            {t('compactHandoff.description', { title: sessionTitle })}
          </p>

          {/* 压缩引擎 + 供应商 + 模型 */}
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-text-secondary">{t('compactHandoff.compactEngineLabel')}</span>
            <EnginePicker
              value={compactEngine}
              onChange={(id) => {
                setCompactEngine(id)
                setCompactProfileId('')
                setCompactModel('')
              }}
            />
            <div className="grid grid-cols-2 gap-2">
              <Dropdown
                value={compactProfileId}
                options={profileOptions}
                placeholder={t('sessionConfig.provider')}
                onChange={(v) => {
                  setCompactProfileId(v)
                  setCompactModel('')
                }}
              />
              <Dropdown
                value={compactModel}
                options={modelOptions}
                placeholder={t('sessionConfig.model')}
                onChange={setCompactModel}
                disabled={modelOptions.length === 0}
              />
            </div>
          </div>

          {/* 压缩要求（可折叠编辑） */}
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setShowInstruction((v) => !v)}
              className="flex items-center gap-1 text-xs font-medium text-text-secondary hover:text-text-primary self-start"
            >
              <ChevronDown size={12} className={clsx('transition-transform', !showInstruction && '-rotate-90')} />
              {t('compactHandoff.instructionLabel')}
            </button>
            {showInstruction && (
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                rows={10}
                className="w-full px-3 py-2 text-xs bg-background-surface border border-border rounded-lg outline-none focus:border-primary resize-y font-mono leading-relaxed"
              />
            )}
          </div>

          {/* 新会话引擎 */}
          <div className="flex flex-col gap-2 pt-1 border-t border-border-subtle">
            <span className="text-xs font-medium text-text-secondary pt-2">{t('compactHandoff.newEngineLabel')}</span>
            <EnginePicker value={newEngine} onChange={setNewEngine} />
          </div>
        </div>

        {/* 底栏 */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border shrink-0">
          <button
            onClick={handleCancel}
            className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
          >
            {t('sessionConfig.cancel')}
          </button>
          <button
            onClick={handleStart}
            className="px-4 py-1.5 text-xs rounded-lg font-medium transition-colors bg-primary text-white hover:bg-primary-hover"
          >
            {t('compactHandoff.start')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default CompactHandoffModal
