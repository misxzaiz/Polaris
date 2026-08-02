/**
 * 状态指示器组件
 */

interface StatusIndicatorProps {
  /** 状态 */
  status: 'online' | 'offline' | 'loading' | 'error';
  /** 文本 */
  label?: string;
  /** 大小 */
  size?: 'sm' | 'md';
}

export function StatusIndicator({
  status,
  label,
  size = 'sm'
}: StatusIndicatorProps) {
  const sizeClass = size === 'sm' ? 'w-2 h-2' : 'w-3 h-3';

  const statusColors = {
    online: 'bg-success shadow-glow',
    offline: 'bg-text-muted',
    loading: 'bg-warning animate-pulse',
    error: 'bg-danger',
  };

  return (
    <div className="flex items-center gap-2">
      <div
        className={`rounded-full ${sizeClass} ${statusColors[status]}`}
        aria-hidden="true"
      />
      {label && (
        <span className="text-sm text-text-secondary">{label}</span>
      )}
    </div>
  );
}
