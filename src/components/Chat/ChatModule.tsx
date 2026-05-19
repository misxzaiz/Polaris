/**
 * ChatModule - AI 对话模块的统一容器
 *
 * 把原本散落在 App.tsx 的整套 Chat 结构 (error 横幅 / MultiSessionGrid /
 * EnhancedChatMessages / ChatStatusBar / ChatInput / QuickSwitchPanel)
 * 收敛为单一组件,使其可以被布局系统装入任意槽位 (right / center)。
 *
 * 设计要点:
 * - 业务态自取: useActiveSessionActions/Streaming/Error 在内部消费,不走 props
 * - bareRender=true: 由 SlotPanel 跳过外层包装,ChatModule 自己提供 flex 结构
 */

import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useViewStore } from '@/stores/viewStore'
import {
  useActiveSessionActions,
  useActiveSessionStreaming,
  useActiveSessionError,
} from '@/stores/conversationStore/useActiveSession'
import {
  ChatInput,
  ChatStatusBar,
  EnhancedChatMessages,
  MultiSessionGrid,
  MultiWindowMenu,
  NewSessionButton,
} from '@/components/Chat'
import { QuickSwitchPanel } from '@/components/QuickSwitchPanel'
import { ToastContainer } from '@/components/Common'

export interface ChatModuleProps {
  /** 是否显示 QuickSwitchPanel (悬浮会话切换器),槽位为 right 时默认 true */
  showQuickSwitch?: boolean
  /** 是否显示 ToastContainer */
  showToast?: boolean
  className?: string
}

export function ChatModule({
  showQuickSwitch = true,
  showToast = true,
  className = '',
}: ChatModuleProps) {
  const currentWorkspace = useWorkspaceStore(
    (state) => state.workspaces.find((w) => w.id === state.currentWorkspaceId) ?? null
  )
  const multiSessionMode = useViewStore((state) => state.multiSessionMode)

  const isStreaming = useActiveSessionStreaming()
  const error = useActiveSessionError()
  const { sendMessage, interrupt: interruptChat } = useActiveSessionActions()

  return (
    <div className={`flex flex-col h-full min-h-0 ${className}`}>
      {showQuickSwitch && <QuickSwitchPanel />}

      {error && (
        <div className="mx-4 mt-4 p-3 bg-danger-faint border border-danger/30 rounded-xl text-danger text-sm shrink-0">
          {error}
        </div>
      )}

      <div className="flex-1 min-h-0 flex flex-col">
        {multiSessionMode ? <MultiSessionGrid /> : <EnhancedChatMessages />}
      </div>

      <div className="relative shrink-0">
        {showToast && <ToastContainer />}
        <ChatStatusBar>
          <MultiWindowMenu />
          <NewSessionButton />
        </ChatStatusBar>
      </div>

      <ChatInput
        onSend={sendMessage}
        onInterrupt={interruptChat}
        disabled={!currentWorkspace}
        isStreaming={isStreaming}
      />
    </div>
  )
}
