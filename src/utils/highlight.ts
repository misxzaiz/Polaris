/**
 * highlight.js 统一初始化（core 模式）
 *
 * 只加载 core + 显式注册的常用语言，避免 `import hljs from 'highlight.js'`
 * 全量打包（~300KB→~30KB，具体收益取决于 tree-shaking）。
 *
 * 两处消费（CodeBlock 动态 highlight、MarkdownEditor highlightElement）
 * 共享此实例，确保语言注册只发生一次、行为一致。
 *
 * 语义说明：
 * - `syntaxHighlighting` 性能开关关闭时，消费方不再调用 highlight，
 *   本模块不参与（模块加载与否由 import 侧决定）。
 * - 未注册的语言（如确没有被列入 LANGUAGE_LIST）会退化为：
 *   - 显式 `highlight(code, {language})`：语言不支持时抛错，
 *     消费方需捕获并降级（CodeBlock 已做 try/catch → highlightAuto）。
 *   - `highlightElement(el)`：DOM 元素带 `language-xxx` class 但语言未注册时，
 *     hljs 会跳过并保留原文本（安全降级）。
 */

import hljs from 'highlight.js/lib/core';
import { LRUCache } from '@/utils/lru-cache';

// ─── 支持的语言清单 ──────────────────────────────────────────────
// 只在这里注册。新增语言需同时补充 LANGUAGE_LIST 与 LANGUAGE_DISPLAY_NAMES。
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import cpp from 'highlight.js/lib/languages/cpp';
import sql from 'highlight.js/lib/languages/sql';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';

/** 已注册语言 → 实现映射（只这里注册一次） */
const LANGUAGE_REGISTRATIONS: Record<string, unknown> = {
  javascript,
  typescript,
  python,
  rust,
  go,
  java,
  cpp,
  sql,
  html: xml,
  css,
  json,
  bash,
  markdown,
  shell: bash,
  yaml,
};

for (const [name, def] of Object.entries(LANGUAGE_REGISTRATIONS)) {
  hljs.registerLanguage(name, def as never);
}

/** 高亮结果缓存（LRU，上限 50 条）——由 CodeBlock 复用 */
export const highlightCache = new LRUCache<string, string>({ maxSize: 50 });

/** 语言 → 显示名（Toolbar 标签） */
export const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
  rust: 'Rust',
  go: 'Go',
  java: 'Java',
  cpp: 'C++',
  sql: 'SQL',
  html: 'HTML',
  css: 'CSS',
  json: 'JSON',
  bash: 'Bash',
  markdown: 'Markdown',
  shell: 'Shell',
  yaml: 'YAML',
};

export default hljs;