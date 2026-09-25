/**
 * token 数量的中文单位格式化。
 *
 * 用中文计数单位「千 / 万 / 亿」替代英文 k/M 后缀，符合中文用户阅读习惯。
 * 进位规则：满十进一（千位满 10 进万、万位满 10 进亿），避免「10千」「10000万」
 * 这类冗长表达。示例：
 *   999      → "999"
 *   1234     → "1.2千"
 *   9999     → "1万"
 *   12345    → "1.2万"
 *   99999999 → "1亿"
 *   123456789 → "1.2亿"
 */

/** 单参数格式化（可空输入返回 '0'），供卡片/水位等展示位使用 */
export function formatTokens(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v <= 0) return '0';
  if (v < 1000) return String(Math.round(v));
  if (v < 10_000) {
    const k = v / 1000;
    if (k >= 9.95) return '1万'; // 四舍五入后进位
    return `${trimZero(k.toFixed(1))}千`;
  }
  if (v < 100_000_000) {
    const wan = v / 10_000;
    if (wan >= 9999.5) return '1亿'; // 接近亿时进位
    return `${trimZero(wan.toFixed(1))}万`;
  }
  return `${trimZero((v / 100_000_000).toFixed(1))}亿`;
}

/** 无空值输入的精简版，供 `fmt` 等已判空的调用点使用 */
export function formatTokensStrict(n: number): string {
  return formatTokens(n);
}

function trimZero(s: string): string {
  return s.replace(/\.0$/, '');
}
