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
import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle, foldGutter, foldKeymap, indentUnit } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches, gotoLine } from '@codemirror/search';
import { lintGutter } from '@codemirror/lint';
import { tags } from '@lezer/highlight';
import { createLogger } from '../../utils/logger';
import { useEditorBufferStore } from '../../stores/editorBufferStore';
import { useEditorSettingsStore } from '../../stores/editorSettingsStore';

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
  /** 是否自动换行 */
  wrapEnabled?: boolean;
  /** 文件路径（用于 EditorState 缓存键） */
  filePath?: string;
}

export function CodeMirrorEditor({
  value,
  language,
  onChange,
  readOnly = false,
  onSave,
  lineNumbers: showLineNumbers = true,
  wrapEnabled = false,
  filePath,
}: EditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;

  // 编辑器设置
  const { fontSize, fontFamily, increaseFontSize, decreaseFontSize, resetFontSize } =
    useEditorSettingsStore()

  // 动态字体主题
  const fontTheme = useMemo(
    () => EditorView.theme({
      '&': {
        fontSize: `${fontSize}px`,
        fontFamily,
      },
    }),
    [fontSize, fontFamily]
  );

  // 字体缩放快捷键
  const zoomKeymap = useMemo(
    () => keymap.of([
      { key: 'Mod-=', run: () => { increaseFontSize(); return true; } },
      { key: 'Mod-Plus', run: () => { increaseFontSize(); return true; } },
      { key: 'Mod--', run: () => { decreaseFontSize(); return true; } },
      { key: 'Mod-0', run: () => { resetFontSize(); return true; } },
    ]),
    [increaseFontSize, decreaseFontSize, resetFontSize]
  );

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
      // 检查缓冲区中是否有缓存的 EditorState
      const cachedState = filePath
        ? useEditorBufferStore.getState().loadBuffer(filePath)?.editorState
        : null;

      if (cachedState && !cancelled && containerRef.current) {
        // 从缓存恢复：保留 undo 历史、光标位置、折叠状态
        log.debug('从缓存恢复 EditorState', { filePath });
        const view = new EditorView({
          state: cachedState,
          parent: containerRef.current,
        });
        viewRef.current = view;
        return;
      }

      // 无缓存，创建新编辑器
      // 异步加载语言扩展
      const langExtension = await getLanguageExtension(language);

      // 如果组件已卸载，不继续
      if (cancelled || !containerRef.current) {
        return;
      }

      // 基础扩展数组
      const extensions = [
        modernTheme,
        fontTheme,
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
        foldGutter(),
        keymap.of(foldKeymap),
        EditorView.editable.of(!readOnly),
        wrapEnabled ? EditorView.lineWrapping : [],
        indentUnit.of('  '),
        saveKeymap,
        keymap.of(defaultKeymap),
        keymap.of(historyKeymap),
        keymap.of(closeBracketsKeymap),
        keymap.of(searchKeymap),
        keymap.of([{ key: 'Mod-g', run: gotoLine }]),
        zoomKeymap,
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
        extensions.push(langExtension);
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

      log.debug('Editor view created successfully');
    };

    createEditor();

    // 清理函数：保存 EditorState 到缓冲区
    return () => {
      cancelled = true;
      if (viewRef.current) {
        // 保存 EditorState（保留 undo 历史、光标、折叠等）
        const currentPath = filePathRef.current;
        if (currentPath) {
          useEditorBufferStore.getState().saveEditorState(currentPath, viewRef.current.state);
        }
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
