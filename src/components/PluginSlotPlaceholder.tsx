/**
 * 插件面板席位占位 —— 通用兜底组件（无业务域语义）。
 *
 * 宿主不再内置任何业务面板：核心 manifest 里保留的 `git.panel` 等席位由插件以
 * `slotMode: 'shadow'` 接管（LeftPanel shadowByBuiltinType）。插件未安装/被禁用时
 * 该席位渲染本占位，而不是空白或崩溃。
 *
 * 文案由调用方传入（席位不同、语言不同），组件本身只负责版式。
 */

export interface PluginSlotPlaceholderProps {
  /** 席位标题（说明这里本该是什么面板） */
  title: string
  /** 指引文案（如何安装/启用对应插件） */
  hint: string
}

export function PluginSlotPlaceholder({ title, hint }: PluginSlotPlaceholderProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 px-6 text-center">
      <div className="text-sm text-text-primary">{title}</div>
      <div className="text-xs text-text-muted leading-relaxed">{hint}</div>
    </div>
  )
}
