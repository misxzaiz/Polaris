/**
 * 快捷键录制组件。
 *
 * 点击进入录制模式，按下实际键位后自动捕获并转为 CodeMirror keymap 格式。
 * 支持系统编辑键黑名单校验，无效组合直接丢弃。
 */

import { useRef, useState } from 'react';

/** CM 禁止的快捷键（已用于系统编辑功能），阻止用户误绑。 */
const BANNED_KEYS = new Set([
  'Mod-c', 'Mod-v', 'Mod-x', 'Mod-z', 'Mod-y', 'Mod-a',
  'Mod-s', 'Mod-g', 'Mod-f', 'Mod-p',
  'Mod-Shift-o',
  'Mod-=', 'Mod-Plus', 'Mod--', 'Mod-0',
  'F12',
  'Alt-ArrowUp', 'Alt-ArrowDown',
]);

/** 映射 DOM KeyboardEvent 的 mainKey 到 CM 格式 */
function cmMainKey(e: KeyboardEvent): string | null {
  const key = e.key;

  // 标准字母数字
  if (key.length === 1 && /^[a-zA-Z0-9]$/.test(key)) {
    return key.toLowerCase();
  }

  // 命名键
  const known: Record<string, string> = {
    'Enter': 'Enter',
    'Tab': 'Tab',
    'Escape': 'Esc',
    'Backspace': 'Backspace',
    'Delete': 'Delete',
    'Home': 'Home',
    'End': 'End',
    'PageUp': 'PageUp',
    'PageDown': 'PageDown',
    'ArrowUp': 'ArrowUp',
    'ArrowDown': 'ArrowDown',
    'ArrowLeft': 'ArrowLeft',
    'ArrowRight': 'ArrowRight',
    'Insert': 'Insert',
    'Space': 'Space',
  };
  if (known[key]) return known[key];

  // F1-F11（F12 被黑名单拦）
  if (/^F([1-9]|1[01])$/.test(key)) return key;

  return null;
}

/** 将 DOM KeyboardEvent 转为 CM keymap 字符串 */
function domEventToCmKey(e: KeyboardEvent): string | null {
  const main = cmMainKey(e);
  if (!main) return null;

  const parts: string[] = [];

  // Mod == Ctrl on Win/Linux, Cmd on Mac。用 e.metaKey 判定 Mac。
  // CM 的 Mod 能正确处理，所以存入 Mod 即可。
  if (e.ctrlKey || e.metaKey) {
    parts.push('Mod');
  }
  if (e.altKey) {
    parts.push('Alt');
  }
  // Shift 只在 mainKey 是字母/符号时才有意义，F 键不合 Shift（那是利用 F 系行的，应该保留）
  // CM 的 Shift- 修饰不会加到 F-keys 上（CM 理解 Shift-F12 是组合）。我们存原样。
  if (e.shiftKey) {
    parts.push('Shift');
  }

  parts.push(main);
  const result = parts.join('-');

  // 简单校验：不能是纯修饰键
  if (BANNED_KEYS.has(result)) return null;
  return result;
}

/** CM keymap 字符串 → 人类可读展示 */
function cmKeyToDisplay(cmKey: string): string {
  return cmKey
    .replace(/^Mod-/g, navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+')
    .replace(/-/g, '+')
    .replace(/^(Ctrl\+|⌘\+)/, (m) => m)
    .replace(/\+/g, '+');
}

interface KeyCaptureProps {
  value: string;
  onChange: (key: string) => void;
  /** 提示文本（如"跳转定义"） */
  label: string;
}

export function KeyCapture({ value, onChange, label }: KeyCaptureProps) {
  const [capturing, setCapturing] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // 按 Tab 退出录制（不改变值）
    if (e.key === 'Tab') {
      setCapturing(false);
      return;
    }

    const cmKey = domEventToCmKey(e.nativeEvent);
    if (cmKey) {
      onChange(cmKey);
      setCapturing(false);
    }
    // 无效组合 → 保持录制状态，用户接着按
  };

  // 点击按钮开始捕获
  const handleClick = () => {
    // 仅从非录制态进入录制态
    if (!capturing) {
      setCapturing(true);
    }
  };

  // 松开录制态：点击其它地方会被按钮的 blur 处理
  const handleBlur = () => {
    setCapturing(false);
  };

  return (
    <button
      ref={ref}
      type="button"
      className={`relative inline-flex items-center justify-center min-w-[120px] h-8 px-3 rounded-md border text-xs font-mono transition-colors focus:outline-none focus:ring-2 focus:ring-primary ${
        capturing
          ? 'border-primary bg-primary/10 text-primary ring-2 ring-primary animate-pulse'
          : 'border-border-subtle bg-background-elevated text-text-primary hover:border-primary'
      }`}
      onClick={handleClick}
      onBlur={handleBlur}
      onKeyDown={capturing ? handleKeyDown : undefined}
      tabIndex={0}
      title={label}
    >
      {capturing ? '按组合键…' : cmKeyToDisplay(value)}
    </button>
  );
}