/**
 * ANSI 转义码 → HTML 颜色转换
 *
 * 将终端输出中的 ANSI 颜色码（\x1b[31m 等）转为 <span style="color:...">
 * 先转义 HTML 特殊字符，再替换 ANSI 序列，确保 XSS 安全。
 */

const ANSI_COLOR_MAP: Record<number, string> = {
  30: '#6e7681', // 黑 / 灰
  31: '#f85149', // 红（错误）
  32: '#3fb950', // 绿（成功）
  33: '#d29922', // 黄（警告）
  34: '#58a6ff', // 蓝（信息）
  35: '#bc8cff', // 紫
  36: '#39c5cf', // 青
  37: '#e6edf3', // 白
  90: '#6e7681', // 亮黑（次要信息）
  91: '#f85149', // 亮红
  92: '#3fb950', // 亮绿
  93: '#d29922', // 亮黄
  94: '#58a6ff', // 亮蓝
  95: '#bc8cff', // 亮紫
  96: '#39c5cf', // 亮青
};

/**
 * 将 ANSI 转义码转换为 HTML 字符串
 * @param text 包含 ANSI 码的原始文本
 * @returns 转换后的 HTML 字符串（已转义 + 颜色 span）
 */
export function ansiToHtml(text: string): string {
  if (!text) return '';

  // 1. 先转义 HTML 特殊字符
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // 2. 替换 ANSI 转义序列为 <span style="color:...">
  // 匹配 \x1b[Nm 或 \x1b[N;N;...m
  html = html.replace(/\x1b\[(\d+(?:;\d+)*)m/g, (_, codesStr) => {
    const codes = codesStr.split(';').map(Number);
    // \x1b[0m = 重置（关闭所有 span）
    if (codes[0] === 0) return '</span>';
    // 取第一个颜色码
    for (const code of codes) {
      const color = ANSI_COLOR_MAP[code];
      if (color) return `<span style="color:${color}">`;
    }
    // 未识别的码（如 1=bold）忽略
    return '';
  });

  return html;
}