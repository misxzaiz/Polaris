/**
 * 代码块组件
 *
 * 功能：
 * - 语法高亮（基于 highlight.js）
 * - 一键复制代码
 * - 显示编程语言标签
 * - 行号切换
 * - 代码折叠（长代码默认折叠）
 * - 暗色主题适配
 * - 异步高亮避免阻塞主线程
 */

import { memo, useState, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Check, List, ListX, ChevronDown, ChevronUp } from 'lucide-react';
import hljs from 'highlight.js';
import { LRUCache } from '../../utils/lru-cache';

// 导入常用语言
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import cpp from 'highlight.js/lib/languages/cpp';
import sql from 'highlight.js/lib/languages/sql';
import html from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import markdown from 'highlight.js/lib/languages/markdown';

// 注册语言
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('html', html);
hljs.registerLanguage('css', css);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('shell', bash);

// 高亮结果缓存（LRU，上限 50 条）
const highlightCache = new LRUCache<string, string>({ maxSize: 50 });

/** 代码行数阈值：超过此行数默认折叠 */
const FOLD_THRESHOLD = 15;

/**
 * 生成缓存键
 */
function getCacheKey(code: string, language: string): string {
  return `${language}:${code.length}:${code.slice(0, 50)}`;
}

interface CodeBlockProps {
  /** 代码内容 */
  children: string;
  /** 语言类型（如 language-typescript） */
  className?: string;
}

/**
 * 从 className 中提取语言
 * 例如：language-typescript -> typescript
 */
function extractLanguage(className?: string): string {
  if (!className) return '';

  const match = /language-(\w+)/.exec(className);
  return match ? match[1] : '';
}

/**
 * 语言别名映射（处理常见的别名）
 */
const languageAliases: Record<string, string> = {
  'js': 'javascript',
  'ts': 'typescript',
  'py': 'python',
  'rs': 'rust',
  'c': 'cpp',
  'sh': 'bash',
  'zsh': 'bash',
  'yaml': 'yaml',
  'yml': 'yaml',
};

/**
 * 获取显示用的语言名称
 */
function getDisplayName(language: string): string {
  const displayNames: Record<string, string> = {
    'javascript': 'JavaScript',
    'typescript': 'TypeScript',
    'python': 'Python',
    'rust': 'Rust',
    'go': 'Go',
    'java': 'Java',
    'cpp': 'C++',
    'sql': 'SQL',
    'html': 'HTML',
    'css': 'CSS',
    'json': 'JSON',
    'bash': 'Bash',
    'markdown': 'Markdown',
  };

  return displayNames[language] || language.toUpperCase();
}

/**
 * 异步执行高亮（使用 requestIdleCallback 或 setTimeout）
 */
function scheduleHighlight(
  code: string,
  language: string,
  callback: (result: string) => void
): () => void {
  // 检查缓存
  const cacheKey = getCacheKey(code, language);
  const cached = highlightCache.get(cacheKey);
  if (cached !== undefined) {
    callback(cached);
    return () => {};
  }

  let cancelled = false;

  const doHighlight = () => {
    if (cancelled) return;

    try {
      const result = hljs.highlight(code, { language }).value;
      highlightCache.set(cacheKey, result);
      if (!cancelled) callback(result);
    } catch {
      try {
        const result = hljs.highlightAuto(code).value;
        highlightCache.set(cacheKey, result);
        if (!cancelled) callback(result);
      } catch {
        if (!cancelled) callback(code);
      }
    }
  };

  // 使用 requestIdleCallback 或 setTimeout 延迟执行
  if ('requestIdleCallback' in window) {
    const id = (window as any).requestIdleCallback(doHighlight, { timeout: 100 });
    return () => {
      cancelled = true;
      (window as any).cancelIdleCallback(id);
    };
  } else {
    const id = setTimeout(doHighlight, 16);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }
}

/**
 * CodeBlock 组件
 *
 * @example
 * ```tsx
 * <CodeBlock className="language-typescript">
 *   const x: number = 1;
 *   console.log(x);
 * </CodeBlock>
 * ```
 */
export const CodeBlock = memo(function CodeBlock({ children, className }: CodeBlockProps) {
  const { t } = useTranslation('chat');
  const [copied, setCopied] = useState(false);
  const [showLineNumbers, setShowLineNumbers] = useState(false);
  const [highlightedCode, setHighlightedCode] = useState<string | null>(null);
  const codeString = String(children).trimEnd();

  // 提取语言
  const language = extractLanguage(className);
  const normalizedLanguage = languageAliases[language] || language;
  const displayName = getDisplayName(normalizedLanguage);

  // 计算行数
  const lineCount = useMemo(() => codeString.split('\n').length, [codeString]);

  // 折叠状态：超过阈值的代码块默认折叠
  const shouldAutoFold = lineCount > FOLD_THRESHOLD;
  const [isCollapsed, setIsCollapsed] = useState(shouldAutoFold);

  // 异步语法高亮
  useEffect(() => {
    if (!normalizedLanguage) {
      setHighlightedCode(null);
      return;
    }

    return scheduleHighlight(codeString, normalizedLanguage, setHighlightedCode);
  }, [codeString, normalizedLanguage]);

  // 复制代码
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(codeString);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      // 降级方案
      const textArea = document.createElement('textarea');
      textArea.value = codeString;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [codeString]);

  // 切换行号显示
  const toggleLineNumbers = useCallback(() => {
    setShowLineNumbers(prev => !prev);
  }, []);

  // 切换折叠状态
  const toggleCollapse = useCallback(() => {
    setIsCollapsed(prev => !prev);
  }, []);

  // 显示原始代码或高亮后的代码
  const displayCode = highlightedCode ?? codeString;
  const useHighlight = highlightedCode !== null;

  // 生成带行号的代码
  const codeWithLineNumbers = useMemo(() => {
    if (!showLineNumbers) return null;
    const lines = codeString.split('\n');
    const maxLineDigits = String(lines.length).length;
    return lines.map((line, index) => {
      const lineNum = String(index + 1).padStart(maxLineDigits, ' ');
      return `${lineNum} | ${line}`;
    }).join('\n');
  }, [showLineNumbers, codeString]);

  return (
    <div className="relative group rounded-lg overflow-hidden bg-background-base border border-border-subtle">
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between px-3 py-2 bg-background-elevated border-b border-border-subtle">
        {/* 语言标签 */}
        <div className="flex items-center gap-3">
          {displayName && (
            <span className="text-xs text-text-tertiary font-mono">{displayName}</span>
          )}
          {lineCount > 1 && (
            <span className="text-xs text-text-muted">{lineCount} {t('codeBlock.lines', { count: lineCount })}</span>
          )}
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center gap-1">
          {/* 折叠/展开按钮 */}
          {shouldAutoFold && (
            <button
              className="px-2.5 py-1 text-xs rounded-md transition-all flex items-center gap-1.5 text-text-tertiary hover:bg-background-hover"
              onClick={toggleCollapse}
              title={isCollapsed ? t('codeBlock.expandCode') : t('codeBlock.collapseCode')}
            >
              {isCollapsed ? (
                <>
                  <ChevronDown className="w-3.5 h-3.5" />
                  {t('codeBlock.expand')}
                </>
              ) : (
                <>
                  <ChevronUp className="w-3.5 h-3.5" />
                  {t('codeBlock.collapse')}
                </>
              )}
            </button>
          )}

          {/* 行号切换按钮 */}
          <button
            className={`px-2.5 py-1 text-xs rounded-md transition-all flex items-center gap-1.5 ${
              showLineNumbers
                ? 'bg-primary/20 text-primary'
                : 'text-text-tertiary hover:bg-background-hover'
            }`}
            onClick={toggleLineNumbers}
            title={showLineNumbers ? t('codeBlock.hideLineNumbers') : t('codeBlock.showLineNumbers')}
          >
            {showLineNumbers ? (
              <>
                <ListX className="w-3.5 h-3.5" />
                {t('codeBlock.lineNumbers')}
              </>
            ) : (
              <>
                <List className="w-3.5 h-3.5" />
                {t('codeBlock.lineNumbers')}
              </>
            )}
          </button>

          {/* 复制按钮 */}
          <button
            className={`px-2.5 py-1 text-xs rounded-md transition-all flex items-center gap-1.5 ${
              copied
                ? 'bg-success text-white'
                : 'text-text-tertiary hover:bg-background-hover'
            }`}
            onClick={handleCopy}
            title={copied ? t('codeBlock.copied') : t('codeBlock.copyCode')}
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5" />
                {t('codeBlock.copied')}
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                {t('codeBlock.copy')}
              </>
            )}
          </button>
        </div>
      </div>

      {/* 代码区域 */}
      <div className="overflow-x-auto">
        {isCollapsed ? (
          /* 折叠状态：显示预览提示 */
          <div
            className="p-4 bg-background-base cursor-pointer hover:bg-background-hover/30 transition-colors relative"
            onClick={toggleCollapse}
            title={t('codeBlock.clickToExpand')}
          >
            <div className="text-xs text-text-muted mb-2">
              {displayName && <span className="font-mono mr-2">{displayName}</span>}
              <span>{t('codeBlock.linesCollapsed', { count: lineCount })}</span>
            </div>
            {/* 显示前 3 行预览 */}
            <pre className="text-sm text-text-tertiary opacity-60 overflow-hidden" style={{ maxHeight: '4.5em' }}>
              <code>{codeString.split('\n').slice(0, 3).join('\n')}</code>
            </pre>
            {/* 渐变遮罩 */}
            <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-background-base to-transparent pointer-events-none" />
            {/* 展开提示 */}
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 text-xs text-text-muted flex items-center gap-1">
              <ChevronDown className="w-3.5 h-3.5" />
              {t('codeBlock.clickToExpandShort')}
            </div>
          </div>
        ) : (
          /* 展开状态：显示完整代码 */
          <pre
            className={`p-4 !bg-background-base !m-0 !rounded-none ${className || ''}`}
            style={{
              margin: 0,
            }}
          >
            {showLineNumbers ? (
              <code className="hljs text-sm">
                {codeWithLineNumbers?.split('\n').map((line, index) => (
                  <div key={index} className="table-row">
                    <span className="table-cell pr-4 text-text-muted select-none text-right border-r border-border-subtle mr-4">
                      {line.split(' | ')[0]}
                    </span>
                    <span className="table-cell pl-4" dangerouslySetInnerHTML={{
                      __html: useHighlight
                        ? (highlightedCode?.split('\n')[index] || line.split(' | ')[1] || '')
                        : (line.split(' | ')[1] || '')
                    }} />
                  </div>
                ))}
              </code>
            ) : useHighlight ? (
              <code
                className="hljs text-sm"
                dangerouslySetInnerHTML={{ __html: displayCode }}
              />
            ) : (
              <code className="text-sm text-text-secondary">{codeString}</code>
            )}
          </pre>
        )}
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  // 自定义比较：只在代码或 className 变化时重新渲染
  return prevProps.children === nextProps.children && prevProps.className === nextProps.className;
});
