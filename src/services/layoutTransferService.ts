/**
 * 布局导入/导出服务
 *
 * 在桌面 (Tauri) 与 Web 两种运行时下统一封装"选择文件 → 读/写文本"流程:
 * - 桌面: 走 @tauri-apps/plugin-dialog + create_file/get_file_content (Rust)
 * - Web:  走 Blob 下载 + 隐藏 <input type="file"> 上传
 *
 * 调用方只需关心 string ↔ string,不感知运行时差异。
 */

import { createFile, readFile } from '@/services/tauri/fileService';

const FILTER_NAME = 'Polaris Layout';
const FILTER_EXT = 'json';

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 让用户选择保存位置并写入文本.
 * 用户取消选择时返回 null,不抛错.
 * @returns 成功保存的文件名 (Web 模式下是建议名,桌面模式下是用户选择的完整路径)
 */
export async function exportLayoutToFile(
  content: string,
  defaultFileName = 'polaris-layout.json'
): Promise<string | null> {
  if (isTauriRuntime()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const destination = await save({
      defaultPath: defaultFileName,
      filters: [{ name: FILTER_NAME, extensions: [FILTER_EXT] }],
    });
    if (!destination) return null;
    await createFile(destination, content);
    return destination;
  }
  // Web fallback: 触发浏览器下载
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = defaultFileName;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
  return defaultFileName;
}

/**
 * 让用户选择文件并读取文本.
 * 用户取消选择时返回 null,不抛错.
 */
export async function importLayoutFromFile(): Promise<string | null> {
  if (isTauriRuntime()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: FILTER_NAME, extensions: [FILTER_EXT] }],
    });
    if (!selected || Array.isArray(selected)) return null;
    return readFile(selected);
  }
  // Web fallback: 隐藏 file input
  return new Promise<string | null>((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = `.${FILTER_EXT},application/json`;
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      input.remove();
      window.removeEventListener('focus', onWindowFocus);
    };
    const resolveOnce = (value: string | null) => {
      if (settled) return;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (err: unknown) => {
      if (settled) return;
      cleanup();
      reject(err);
    };

    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolveOnce(null);
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => rejectOnce(reader.error ?? new Error('Failed to read layout file'));
      reader.onload = () => {
        const result = reader.result;
        resolveOnce(typeof result === 'string' ? result : null);
      };
      reader.readAsText(file);
    };

    // 现代浏览器 (Chrome/Edge/Firefox 91+) 在用户点击 cancel 时触发 cancel 事件
    input.addEventListener('cancel', () => resolveOnce(null));

    // 兜底: 监听 window focus,如果焦点回到 window 且 input.files 仍为空,视为取消
    // (覆盖不支持 'cancel' 事件的老 webview)
    const onWindowFocus = () => {
      // 给浏览器一点时间触发 onchange (如果用户确实选了文件)
      setTimeout(() => {
        if (!settled && (!input.files || input.files.length === 0)) {
          resolveOnce(null);
        }
      }, 300);
    };
    window.addEventListener('focus', onWindowFocus);

    input.style.display = 'none';
    document.body.appendChild(input);
    input.click();
  });
}
