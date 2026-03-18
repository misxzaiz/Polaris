/**
 * CodeMirror 6 编辑器组件
 */

import { useEffect, useRef, useMemo } from 'react';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  keymap,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightActiveLine,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { lintGutter } from '@codemirror/lint';
import { tags } from '@lezer/highlight';
import { createLogger } from '../../utils/logger';

const log = createLogger('Editor');

// 现代化主题
import { modernTheme } from './modernTheme';

const customHighlightStyle = HighlightStyle.define([
  // 关键字
  { tag: tags.keyword, color: '#ff7b72', fontWeight: '500' },
  { tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName], color: '#e6edf3' },
  // 变量
  { tag: [tags.variableName], color: '#e6edf3' },
  // 函数
  { tag: [tags.function(tags.variableName)], color: '#d2a8ff', fontWeight: '500' },
  { tag: [tags.function(tags.propertyName)], color: '#d2a8ff' },
  // 类型/类名
  { tag: [tags.className], color: '#ffa657' },
  { tag: [tags.typeName], color: '#ffa657' },
  // 字符串
  { tag: tags.string, color: '#a5d6ff' },
  // 数字
  { tag: tags.number, color: '#79c0ff' },
  // 常量/布尔值
  { tag: [tags.bool, tags.null, tags.special(tags.variableName)], color: '#79c0ff' },
  // 运算符
  { tag: tags.operator, color: '#ff7b72' },
  // 注释
  { tag: tags.comment, color: '#8b949e', fontStyle: 'italic', opacity: 0.85 },
  // 标签 (HTML/JSX)
  { tag: tags.tagName, color: '#7ee787' },
  { tag: tags.angleBracket, color: '#e6edf3' },
  // 属性名
  { tag: tags.attributeName, color: '#79c0ff' },
  // 正则表达式
  { tag: tags.regexp, color: '#a5d6ff' },
  // 模块名
  { tag: tags.namespace, color: '#d2a8ff' },
  // 括号
  { tag: tags.bracket, color: '#e6edf3' },
  // 链接
  { tag: tags.link, color: '#58a6ff', textDecoration: 'underline' },
  // 强调
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '700' },
  // 标题
  { tag: tags.heading, fontWeight: '600', color: '#e6edf3' },
  // 列表
  { tag: tags.list, color: '#58a6ff' },
]);

// 获取语言扩展
async function getLanguageExtension(lang: string) {
  const langMap: Record<string, any> = {
    // JavaScript / TypeScript
    javascript: () => import('@codemirror/lang-javascript').then(m => m.javascript({ jsx: true })),
    typescript: () => import('@codemirror/lang-javascript').then(m => m.javascript({ jsx: true, typescript: true })),
    json: () => import('@codemirror/lang-json').then(m => m.json()),
    // Web
    html: () => import('@codemirror/lang-html').then(m => m.html()),
    css: () => import('@codemirror/lang-css').then(m => m.css()),
    // Markdown
    markdown: () => import('@codemirror/lang-markdown').then(m => m.markdown()),
    // Python
    python: () => import('@codemirror/lang-python').then(m => m.python()),
    // Java
    java: () => import('@codemirror/lang-java').then(m => m.java()),
    // Rust
    rust: () => import('@codemirror/lang-rust').then(m => m.rust()),
    // C/C++
    c: () => import('@codemirror/lang-cpp').then(m => m.cpp()),
    cpp: () => import('@codemirror/lang-cpp').then(m => m.cpp()),
    // Go
    go: () => import('@codemirror/lang-go').then(m => m.go()),
    // SQL
    sql: () => import('@codemirror/lang-sql').then(m => m.sql()),
    // XML
    xml: () => import('@codemirror/lang-xml').then(m => m.xml()),
  };

  return langMap[lang]?.() || Promise.resolve(null);
}

interface EditorProps {
  /** 编辑器内容 */
  value: string;
  /** 语言类型 */
  language: string;
  /** 内容变化回调 */
  onChange: (value: string) => void;
  /** 只读模式 */
  readOnly?: boolean;
  /** 保存回调 */
  onSave?: () => void;
  /** 是否显示行号 */
  lineNumbers?: boolean;
}

export function CodeMirrorEditor({
  value,
  language,
  onChange,
  readOnly = false,
  onSave,
  lineNumbers: showLineNumbers = true,
}: EditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  // 自定义保存快捷键
  const saveKeymap = useMemo(
    () => keymap.of(onSave ? [{ key: 'Mod-s', run: () => { onSave(); return true; } }] : []),
    [onSave]
  );

  // 初始化编辑器（组件通过 key 属性强制重新挂载，所以只需在挂载时执行一次）
  useEffect(() => {
    if (!containerRef.current) return;

    let cancelled = false;

    // 异步创建编辑器（需要加载语言扩展）
    const createEditor = async () => {
      console.log('[Editor] createEditor called with:', {
        language,
        valueLength: value?.length,
        valuePreview: value?.substring(0, 50),
      });

      // 异步加载语言扩展
      const langExtension = await getLanguageExtension(language);

      console.log('[Editor] Language extension result:', {
        language,
        loaded: !!langExtension,
        extensionType: langExtension?.constructor?.name,
      });

      // 如果组件已卸载，不继续
      if (cancelled || !containerRef.current) {
        console.log('[Editor] Component cancelled or container missing, aborting');
        return;
      }

      // 基础扩展数组
      const extensions = [
        modernTheme,
        syntaxHighlighting(customHighlightStyle, { fallback: true }),
        highlightSpecialChars(),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        showLineNumbers ? lineNumbers() : [],
        highlightSelectionMatches(),
        history(),
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        EditorView.editable.of(!readOnly),
        saveKeymap,
        keymap.of(defaultKeymap),
        keymap.of(historyKeymap),
        keymap.of(closeBracketsKeymap),
        keymap.of(searchKeymap),
        lintGutter(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const newValue = update.state.doc.toString();
            onChange(newValue);
          }
        }),
      ];

      // 如果语言扩展加载成功，添加到扩展数组中
      if (langExtension) {
        console.log('[Editor] Adding language extension to extensions array');
        extensions.push(langExtension);
      } else {
        console.warn('[Editor] No language extension found for:', language);
      }

      // 创建编辑器状态
      const state = EditorState.create({
        doc: value,
        extensions,
      });

      // 创建编辑器视图
      const view = new EditorView({
        state,
        parent: containerRef.current,
      });
      viewRef.current = view;

      log.debug('Editor view created successfully', {
        className: view.dom.className,
        childElementCount: view.dom.childElementCount,
      });
    };

    createEditor();

    // 清理函数
    return () => {
      cancelled = true;
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
    // 只在组件挂载时执行，props 变化时通过 key 强制重新挂载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-hidden"
    />
  );
}
