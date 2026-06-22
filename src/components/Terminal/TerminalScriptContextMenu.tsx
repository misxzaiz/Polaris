import { useEffect, useRef } from 'react';
import { Copy, EyeOff, ExternalLink, Pencil, Play, RotateCcw, Square, Trash2 } from 'lucide-react';
import type { TerminalScript } from '@/types/terminalScript';

interface TerminalScriptContextMenuProps {
  visible: boolean;
  x: number;
  y: number;
  script: TerminalScript | null;
  isCustom: boolean;
  isRunning: boolean;
  onClose: () => void;
  onRun: () => void;
  onStop: () => void;
  onRunExternal: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDeleteOrHide: () => void;
}

export function TerminalScriptContextMenu({
  visible,
  x,
  y,
  script,
  isCustom,
  isRunning,
  onClose,
  onRun,
  onStop,
  onRunExternal,
  onEdit,
  onDuplicate,
  onDeleteOrHide,
}: TerminalScriptContextMenuProps) {
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

  if (!visible || !script) return null;

  const itemClass = 'w-full px-3 py-2 text-left text-xs flex items-center gap-2 text-text-primary hover:bg-background-hover';

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[190px] bg-background-elevated border border-border rounded-md shadow-lg py-1"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button className={itemClass} onClick={() => { onRun(); onClose(); }} disabled={isRunning}>
        <Play size={13} />运行
      </button>
      <button className={itemClass} onClick={() => { onStop(); onClose(); }} disabled={!isRunning}>
        <Square size={13} />停止
      </button>
      <button className={itemClass} onClick={() => { onRun(); onClose(); }}>
        <RotateCcw size={13} />重新运行
      </button>
      <button className={itemClass} onClick={() => { onRunExternal(); onClose(); }}>
        <ExternalLink size={13} />在外部终端运行
      </button>
      <div className="my-1 border-t border-border-subtle" />
      <button className={itemClass} onClick={() => { navigator.clipboard?.writeText(script.command); onClose(); }}>
        <Copy size={13} />复制命令
      </button>
      <button className={itemClass} onClick={() => { onEdit(); onClose(); }}>
        <Pencil size={13} />编辑
      </button>
      <button className={itemClass} onClick={() => { onDuplicate(); onClose(); }}>
        <Copy size={13} />复制为自定义命令
      </button>
      <div className="my-1 border-t border-border-subtle" />
      <button
        className={`w-full px-3 py-2 text-left text-xs flex items-center gap-2 ${isCustom ? 'text-danger hover:bg-danger/10' : 'text-warning hover:bg-warning/10'}`}
        onClick={() => { onDeleteOrHide(); onClose(); }}
      >
        {isCustom ? <Trash2 size={13} /> : <EyeOff size={13} />}
        {isCustom ? '删除自定义命令' : '隐藏项目脚本'}
      </button>
    </div>
  );
}
