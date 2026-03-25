/**
 * 右键上下文菜单组件
 */

import { useEffect, useRef } from 'react';
import type { FileInfo } from '../../types';
import type { ReactNode } from 'react';

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: string | ReactNode;
  action: () => void | Promise<void>;
  disabled?: boolean;
}

interface ContextMenuProps {
  visible: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ visible, x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef<{ x: number; y: number }>({ x, y });

  // 更新位置
  useEffect(() => {
    positionRef.current = { x, y };
  }, [x, y]);

  // 调整菜单位置，避免超出视口
  useEffect(() => {
    if (!visible || !menuRef.current) return;

    const menu = menuRef.current;
    const rect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let adjustedX = positionRef.current.x;
    let adjustedY = positionRef.current.y;

    // 右边界检测
    if (adjustedX + rect.width > viewportWidth) {
      adjustedX = viewportWidth - rect.width - 8;
    }

    // 下边界检测
    if (adjustedY + rect.height > viewportHeight) {
      adjustedY = viewportHeight - rect.height - 8;
    }

    // 应用调整后的位置
    if (adjustedX !== positionRef.current.x || adjustedY !== positionRef.current.y) {
      menu.style.left = `${adjustedX}px`;
      menu.style.top = `${adjustedY}px`;
    }
  }, [visible]);

  // 点击外部关闭菜单
  useEffect(() => {
    if (!visible) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleScroll = () => {
      onClose();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('scroll', handleScroll, true);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('scroll', handleScroll, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [visible, onClose]);

  if (!visible || items.length === 0) {
    return null;
  }

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-background-surface border border-border rounded-lg shadow-lg py-1 min-w-[160px]"
      style={{ left: `${x}px`, top: `${y}px` }}
    >
      {items.map((item) => {
        // 分隔符
        if (item.label === '-') {
          return (
            <div
              key={item.id}
              className="my-1 mx-2 border-t border-border"
            />
          );
        }

        // 普通菜单项
        return (
          <button
            key={item.id}
            type="button"
            className={`w-full px-3 py-2 text-left text-sm flex items-center gap-2 transition-colors ${
              item.disabled
                ? 'text-text-muted cursor-not-allowed'
                : 'text-text-secondary hover:bg-background-hover hover:text-text-primary'
            }`}
            disabled={item.disabled}
            onClick={async () => {
              if (item.disabled) return;
              onClose();
              await item.action();
            }}
          >
            {item.icon && (
              <span className="text-base flex-shrink-0">
                {typeof item.icon === 'string' ? item.icon : item.icon}
              </span>
            )}
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * 判断文件是否为 HTML 文件
 */
export function isHtmlFile(file: FileInfo): boolean {
  if (file.is_dir) return false;
  const ext = file.extension?.toLowerCase();
  return ext === 'html' || ext === 'htm';
}
