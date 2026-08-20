/**
 * 剪贴板工具函数
 *
 * 统一复制到剪贴板的实现，优先 navigator.clipboard API，回退 execCommand
 * 所有需要复制功能的组件统一使用此函数
 */

export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}
