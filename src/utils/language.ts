/**
 * 语言检测工具
 * 根据文件扩展名获取 highlight.js 语言名称
 */

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  md: 'markdown',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'css',
  less: 'css',
  xml: 'xml',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  dart: 'dart',
  swift: 'swift',
  kt: 'kotlin',
  scala: 'scala',
  vue: 'html',
  svelte: 'html',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
}

/**
 * 根据文件路径获取 highlight.js 语言名称
 * @param filePath 文件路径（如 "src/App.tsx"）
 * @returns highlight.js 语言名称，未知扩展名返回 'plaintext'
 */
export function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return EXTENSION_LANGUAGE_MAP[ext] ?? 'plaintext'
}

/**
 * 检查语言是否支持语法高亮
 * @param language highlight.js 语言名称
 */
export function isHighlightableLanguage(language: string): boolean {
  return language !== 'plaintext' && language !== 'text'
}
