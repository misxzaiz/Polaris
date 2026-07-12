import { useEffect, useRef } from 'react';
import { Copy, RotateCcw, Square, X } from 'lucide-react';
import type { TerminalSession } from '@/types/terminal';

interface TerminalTabContextMenuProps {
  visible: boolean;
  x: number;
  y: number;
  session: TerminalSession | null;
  command?: string;
  onClose: () => void;
  onCloseSession: () => void;
  onStopScript?: () => void;
  onRerunScript?: () => void;
}

export function TerminalTabContextMenu({
  visible,
  x,
  y,
  session,
  command,
  onClose,
  onCloseSession,
  onStopScript,
  onRerunScript,
}: TerminalTabContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, visible]);

  if (!visible || !session) return null;

  const itemClass = 'w-full px-3 py-2 text-left text-xs flex items-center gap-2 text-text-primary hover:bg-background-hover';

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[180px] bg-background-elevated border border-border rounded-md shadow-lg py-1"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {session.scriptId && (
        <>
          <button className={itemClass} onClick={() => { onStopScript?.(); onClose(); }}>
            <Square size={13} />停止关联脚本
          </button>
          <button className={itemClass} onClick={() => { onRerunScript?.(); onClose(); }}>
            <RotateCcw size={13} />重新运行关联脚本
          </button>
          {command && (
            <button className={itemClass} onClick={() => { navigator.clipboard?.writeText(command); onClose(); }}>
              <Copy size={13} />复制脚本命令
            </button>
          )}
          <div className="my-1 border-t border-border-subtle" />
        </>
      )}
      <button className="w-full px-3 py-2 text-left text-xs flex items-center gap-2 text-danger hover:bg-danger/10" onClick={() => { onCloseSession(); onClose(); }}>
        <X size={13} />关闭终端
      </button>
    </div>
  );
}
