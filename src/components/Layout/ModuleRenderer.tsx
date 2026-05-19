/**
 * ModuleRenderer - 模块 id → 实际组件的注册表
 *
 * 设计目的:
 * 1. SlotPanel/LayoutShell 不需要硬编码模块清单,改成"按 moduleId 查找"
 * 2. 大型模块(DeveloperPanel/IntegrationPanel) 通过 React.lazy 拆 bundle
 * 3. 把"需要外部 callback 的模块"用 wrapper 收敛,内部自取业务 hook
 *
 * 实现要点:
 * - 所有模块包装为 zero-prop 组件,registry 类型干净不需要强转
 * - Suspense 在 ModuleRenderer 顶层提供唯一 fallback,避免重复嵌套
 */

import { Suspense, lazy, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ModuleId } from '@/types/layout'

import { FileExplorer } from '@/components/Common'
import { GitPanel } from '@/components/GitPanel'
import { SimpleTodoPanel } from '@/components/TodoPanel/SimpleTodoPanel'
import { TranslatePanel } from '@/components/Translate'
import { SchedulerPanel } from '@/components/Scheduler/SchedulerPanel'
import { LongGoalPanel } from '@/components/LongGoalPanel'
import { RequirementPanel } from '@/components/RequirementPanel/RequirementPanel'
import { TerminalPanel } from '@/components/Terminal/TerminalPanel'
import { ProblemsPanel } from '@/components/Problems/ProblemsPanel'
import { DemoPluginPanel } from '@/components/Plugins/DemoPluginPanel'
import { ChatModule } from '@/components/Chat/ChatModule'

import { useTabStore } from '@/stores/tabStore'
import { useActiveSessionActions } from '@/stores/conversationStore/useActiveSession'

const DeveloperPanel = lazy(() =>
  import('@/components/Developer/DeveloperPanel').then((m) => ({ default: m.DeveloperPanel }))
)
const IntegrationPanel = lazy(() =>
  import('@/components/Integration/IntegrationPanel').then((m) => ({ default: m.IntegrationPanel }))
)

function ModuleLoading() {
  const { t } = useTranslation('common')
  return (
    <div className="flex items-center justify-center h-full text-text-muted">
      {t('status.loading')}
    </div>
  )
}

// ============================================================
// Zero-prop wrappers (所有模块统一签名为 () => ReactNode)
// ============================================================

function FilesModule() {
  return <FileExplorer />
}
function TodoModule() {
  return <SimpleTodoPanel />
}
function SchedulerModule() {
  return <SchedulerPanel />
}
function LongGoalModule() {
  return <LongGoalPanel />
}
function RequirementModule() {
  return <RequirementPanel />
}
function TerminalModule() {
  return <TerminalPanel />
}
function ProblemsModule() {
  return <ProblemsPanel />
}
function ChatModuleWrapper() {
  return <ChatModule />
}

function GitModule() {
  const openDiffTab = useTabStore((state) => state.openDiffTab)
  return <GitPanel onOpenDiffInTab={openDiffTab} />
}

function TranslateModule() {
  const { sendMessage } = useActiveSessionActions()
  return <TranslatePanel onSendToChat={sendMessage} />
}

function DemoPluginModule() {
  const { sendMessage } = useActiveSessionActions()
  return <DemoPluginPanel onSendToChat={sendMessage} />
}

function DeveloperModule() {
  return <DeveloperPanel fillRemaining />
}

function IntegrationModule() {
  return <IntegrationPanel />
}

// ============================================================
// 注册表
// ============================================================

type ModuleComponent = () => ReactNode

const REGISTRY: Record<ModuleId, ModuleComponent> = {
  chat: ChatModuleWrapper,
  files: FilesModule,
  git: GitModule,
  todo: TodoModule,
  translate: TranslateModule,
  scheduler: SchedulerModule,
  longGoal: LongGoalModule,
  requirement: RequirementModule,
  terminal: TerminalModule,
  problems: ProblemsModule,
  developer: DeveloperModule,
  integration: IntegrationModule,
  demoPlugin: DemoPluginModule,
}

export interface ModuleRendererProps {
  moduleId: ModuleId
}

export function ModuleRenderer({ moduleId }: ModuleRendererProps): ReactNode {
  const Comp = REGISTRY[moduleId]
  if (!Comp) return null
  return (
    <Suspense fallback={<ModuleLoading />}>
      <Comp />
    </Suspense>
  )
}

/** @internal 用于 LayoutShell 决定 keep-alive 时的 ModuleId 枚举 */
export function listRegisteredModules(): ModuleId[] {
  return Object.keys(REGISTRY) as ModuleId[]
}
