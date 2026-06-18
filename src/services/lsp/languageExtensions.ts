/**
 * 语言 ID → 文件扩展名映射（索引模式扫描用）。
 *
 * 与 `fileEditorStore.getLanguageFromPath` 的方向相反：那里是 扩展名→语言，
 * 这里是 语言→应扫描的扩展名集合。索引模式据此决定遍历哪些文件。
 */

const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
  typescript: ['ts', 'tsx', 'mts', 'cts'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  typescriptreact: ['tsx'],
  javascriptreact: ['jsx'],
  json: ['json', 'jsonc'],
  python: ['py', 'pyi'],
  rust: ['rs'],
  go: ['go'],
  java: ['java'],
  c: ['c', 'h'],
  cpp: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'h'],
  csharp: ['cs'],
  php: ['php'],
  ruby: ['rb'],
  shell: ['sh', 'bash', 'zsh', 'fish'],
  sql: ['sql'],
  dart: ['dart'],
  swift: ['swift'],
  kotlin: ['kt', 'kts'],
  scala: ['scala', 'sc'],
  html: ['html', 'htm'],
  css: ['css', 'scss', 'less'],
  xml: ['xml'],
  yaml: ['yaml', 'yml'],
  toml: ['toml'],
  markdown: ['md', 'markdown'],
};

/**
 * 给定语言 ID 列表，返回去重后的扩展名集合。
 * 未知语言回退为"用语言名本身作为扩展名"（容错处理）。
 */
export function extensionsForLanguages(languages: string[]): string[] {
  const set = new Set<string>();
  for (const lang of languages) {
    const exts = LANGUAGE_EXTENSIONS[lang];
    if (exts) {
      exts.forEach((e) => set.add(e));
    } else if (lang.trim()) {
      set.add(lang.trim().toLowerCase());
    }
  }
  return Array.from(set);
}
