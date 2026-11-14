/**
 * 主面板席位空态 —— chat 席位插件化后的通用兜底（ai-chat-plugin-extraction-spec P1.2）。
 *
 * 内置 Chat 出仓为 chat-desk 插件后，App.tsx 主内容区（RightPanel）的 `chat.main`
 * 席位由插件以 `area: 'mainSurface'` + `slotMode: 'shadow'` 接管；插件未安装/被
 * 禁用时渲染本占位（对齐 PluginSlotPlaceholder / TerminalSlotEmpty 范式——
 * 空态引导卡不是隐藏兜底，不携带任何可运行的内置实现）。
 */
import { PluginSlotPlaceholder } from '../PluginSlotPlaceholder'

export function ChatMainSlot() {
  return (
    <PluginSlotPlaceholder
      title="AI 对话已迁移为插件"
      hint="安装并启用 chat-desk 插件后，此席位由插件面板接管（会话、消息流、输入区与全部对话能力）。插件管理：设置 → 插件。"
    />
  )
}
