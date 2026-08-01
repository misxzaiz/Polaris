/**
 * 引擎行（摘要 + 展开容器）
 */
import { ChevronRight, ChevronDown, Cpu, Terminal } from 'lucide-react';
import type { ReactNode } from 'react';
import type { EngineRuntimeStatus } from './tabs/AIEngineTab';

interface EngineRowProps {
  icon: 'terminal' | 'cpu';
  name: string;
  status: EngineRuntimeConfig;
  isDefault: boolean;
  isExpanded: boolean;
  dimmed?: boolean;
  /** 折叠态显示的额外操作按钮（如"设为默认""安装"） */
  actions?: ReactNode;
  onToggle: () => void;
  children?: ReactNode;
}

const STATUS_STYLES = {
  builtin: 'text-blue-500 bg-blue-500/10 border-blue-500/20',
  installed: 'text-green-500 bg-green-500/10 border-green-500/20',
  missing: 'text-text-tertiary bg-text-tertiary/10 border-border',
} as const;

interface EngineRuntimeConfig {
  kind: 'builtin' | 'installed' | 'missing';
  label: string;
}

export function getStatusConfig(status: EngineRuntimeStatus, builtin: boolean | undefined): EngineRuntimeConfig {
  if (builtin) return { kind: 'builtin', label: '内置' };
  if (status.available) {
    return {
      kind: 'installed',
      label: status.version ? `v${status.version.replace(/^v/, '')}` : '已安装',
    };
  }
  return { kind: 'missing', label: '未安装' };
}

export function EngineRow({
  icon,
  name,
  status,
  isDefault,
  isExpanded,
  dimmed,
  actions,
  onToggle,
  children,
}: EngineRowProps) {
  const IconComp = icon === 'cpu' ? Cpu : Terminal;
  const iconColor = icon === 'cpu' ? 'text-blue-500' : 'text-text-tertiary';

  return (
    <div>
      {/* 标题行 */}
      <button
        type="button"
        onClick={onToggle}
        className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border transition-colors text-left
          ${isExpanded
            ? 'border-primary/30 bg-primary/5 rounded-b-none'
            : 'border-border bg-surface hover:border-primary/30'
          }
          ${dimmed ? 'opacity-60' : ''}
        `}
      >
        <IconComp size={16} className={`${iconColor} shrink-0`} />
        <span className="flex-1 text-sm font-medium text-text-primary truncate">{name}</span>

        {/* 状态徽章 */}
        <span className={`text-xs px-2 py-0.5 rounded border shrink-0 ${STATUS_STYLES[status.kind]}`}>
          {status.label}
        </span>

        {/* 默认标记 */}
        {isDefault && (
          <span className="text-xs px-2 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 shrink-0">
            默认
          </span>
        )}

        {/* 动作按钮（折叠态） */}
        {actions && !isExpanded && (
          <span onClick={(e) => e.stopPropagation()}>{actions}</span>
        )}

        {/* 展开/折叠箭头 */}
        {isExpanded
          ? <ChevronDown size={14} className="text-text-tertiary shrink-0" />
          : <ChevronRight size={14} className="text-text-tertiary shrink-0" />
        }
      </button>

      {/* 展开区域 */}
      {isExpanded && children && (
        <div className="border border-t-0 border-primary/30 rounded-b-lg bg-surface px-3 pb-3">
          {children}
        </div>
      )}
    </div>
  );
}