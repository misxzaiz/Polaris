/**
 * SlotEmpty —— 内建席位空态卡（插件化拆除后的通用占位）
 *
 * 席位契约保留（LeftPanel builtinPanels 键 / TabStrip / ToolSwitcher 不变），
 * 内容随功能域插件化出仓后显示引导卡（对齐 terminal 拆除规划的席位空态方案）。
 */
interface SlotEmptyProps {
  icon: string;
  title: string;
  description: string;
}

export function SlotEmpty({ icon, title, description }: SlotEmptyProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <div className="text-3xl opacity-40">{icon}</div>
      <div className="text-sm font-medium text-text-primary">{title}</div>
      <div className="max-w-60 text-xs leading-relaxed text-text-tertiary">{description}</div>
    </div>
  );
}
