/**
 * CSS 安全校验器
 *
 * 在应用层对用户自定义 CSS 做静态安全检查：
 * - 禁止 @import 外部资源
 * - 禁止 url() 引用外部 http(s) 资源
 * - 禁止 expression() 和 javascript: 协议
 * - 禁止 @charset 覆盖
 *
 * 双层防护：CSP 网络层（浏览器自动执行）+ 此处应用层校验（导入时静态检查）
 */

/** CSS 校验结果 */
export interface CssValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** 校验用户自定义 CSS */
export function validateCustomCss(css: string): CssValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!css || !css.trim()) {
    return { valid: true, errors: [], warnings: [] };
  }

  // 禁止 @import 外部资源
  if (/@import\s+url\s*\(\s*['"]?\s*https?:\/\//i.test(css) || /@import\s+['"]https?:\/\//i.test(css)) {
    errors.push('不允许 @import 外部资源，仅允许内联样式');
  }

  // 禁止通过 @import 引用本地文件
  if (/@import\s+['"]file:\/\//i.test(css)) {
    errors.push('不允许 @import 引用本地文件');
  }

  // 禁止 url() 引用外部 http(s) 资源
  if (/url\s*\(\s*['"]?\s*https?:\/\//i.test(css)) {
    errors.push('不允许 url() 引用外部 http(s) 资源，仅允许 data: 和相对路径');
  }

  // 禁止 expression()（防御性拦截）
  if (/expression\s*\(/i.test(css)) {
    errors.push('不允许 CSS expression()');
  }

  // 禁止 javascript: 协议
  if (/javascript:/i.test(css)) {
    errors.push('不允许 javascript: 协议');
  }

  // 禁止 @charset 覆盖
  if (/@charset/i.test(css)) {
    errors.push('不允许 @charset 规则');
  }

  // 警告：大量 !important 可能影响正常样式
  const importantCount = (css.match(/!important/g) || []).length;
  if (importantCount > 20) {
    warnings.push(`使用了 ${importantCount} 个 !important，建议减少使用量`);
  }

  // 警告：CSS 过长
  if (css.length > 50 * 1024) {
    warnings.push('CSS 超过 50KB，可能影响性能');
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** 清理 CSS 中的不安全内容（返回安全子集） */
export function sanitizeCss(css: string): string {
  // 移除 @import 规则
  let sanitized = css.replace(/@import\s+[^;]+;/gi, '');

  // 移除 @charset 规则
  sanitized = sanitized.replace(/@charset\s+[^;]+;/gi, '');

  // 移除 expression()
  sanitized = sanitized.replace(/expression\s*\([^)]*\)/gi, '');

  // 移除 javascript: 协议
  sanitized = sanitized.replace(/javascript:/gi, 'blocked:');

  // 替换外部 url() 为占位
  sanitized = sanitized.replace(/url\s*\(\s*['"]?\s*https?:\/\/[^)]+\)/gi, 'url(#blocked)');

  return sanitized;
}