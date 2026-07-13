import { Archive } from 'lucide-react'

import { useActiveSession } from '@/stores/conversationStore/useActiveSession'
import {
  useActiveSessionId,
  useSessionMetadataList,
} from '@/stores/conversationStore/sessionStoreManager'

/** 主聊天状态栏的 SimpleAI 手动上下文压缩入口。 */
export function CompactContextButton() {
  const activeSessionId = useActiveSessionId()
  const metadata = useSessionMetadataList().find(item => item.id === activeSessionId)
  const { conversationId, isStreaming, compactContext } = useActiveSession()

  if (metadata?.engineId !== 'simple-ai' || !conversationId) return null

  return (
    <button
      type="button"
      onClick={() => void compactContext()}
      disabled={isStreaming}
      className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-text-muted transition-colors hover:bg-background-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
      title={isStreaming ? '当前会话运行结束后可压缩上下文' : '压缩上下文并交接到新的运行时会话'}
    >
      <Archive className="h-3.5 w-3.5" />
      <span>压缩上下文</span>
    </button>
  )
}
