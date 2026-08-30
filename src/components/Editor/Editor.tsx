/**
 * CodeMirror 6 编辑器组件
 */

import { useEffect, useRef, useMemo } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, addCursorAbove, addCursorBelow } from '@codemirror/commands';
import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle, foldGutter, foldKeymap, indentUnit } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches, gotoLine } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { createLogger } from '@/utils/logger';
import { useFileEditorStore } from '@/stores/fileEditorStore';
import { useEditorSettingsStore } from '@/stores/editorSettingsStore';
import { useEditorContextStore } from '@/stores/editorContextStore';
import { useLspStore } from '@/stores/lspStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { formatDocumentForFile } from '@/services/lsp/lspFormatting';
import { indentGuides, indentGuideTheme } from './indentGuides';
import { trailingWhitespaceHighlight } from './trailingWhitespace';
import { rainbowBrackets } from './rainbowBrackets';
import { editorExtensionRegistry } from '@/plugin-system/editorExtensionRegistry';

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

// 所有支持语言的动态加载器。
// - 默认（codeEditorLanguages=false）：打开文件时按扩展名单点 import，零预加载。
// - 开启 codeEditorLanguages：useAppInit 调用 preloadLanguageExtensions() 在 idle 时
//   预热全部语言包，使后续打开任意文件时 import 命中模块缓存、消除首延迟。
// 语言键与 langMap 一致，供预加载与单点加载共用。
export const LANGUAGE_LOADERS: Record<string, () => Promise<unknown>> = {
  // JavaScript / TypeScript
  javascript: () => import('@codemirror/lang-javascript'),
  typescript: () => import('@codemirror/lang-javascript'),
  json: () => import('@codemirror/lang-json'),
  // Web
  html: () => import('@codemirror/lang-html'),
  css: () => import('@codemirror/lang-css'),
  // Markdown
  markdown: () => import('@codemirror/lang-markdown'),
  // Python
  python: () => import('@codemirror/lang-python'),
  // Java
  java: () => import('@codemirror/lang-java'),
  // Rust
  rust: () => import('@codemirror/lang-rust'),
  // C/C++
  c: () => import('@codemirror/lang-cpp'),
  cpp: () => import('@codemirror/lang-cpp'),
  // Go
  go: () => import('@codemirror/lang-go'),
  // SQL
  sql: () => import('@codemirror/lang-sql'),
  // XML
  xml: () => import('@codemirror/lang-xml'),
};

/**
 * 预加载全部编辑器语言包。
 * 仅在 performance.codeEditorLanguages=true 时由 useAppInit 调用。
 * 并行触发所有 dynamic import，不阻塞主线程；失败仅记录，不影响编辑器正常工作
 * （单点加载路径仍兜底，预加载只是预热模块缓存）。
 */
export async function preloadLanguageExtensions(): Promise<void> {
  const tasks = Object.values(LANGUAGE_LOADERS).map((loader) =>
    loader().catch((err) => {
      // 预加载失败不致命：打开文件时单点 import 会重试
      console.warn('[Editor] language preload failed:', err);
    }),
  );
  await Promise.allSettled(tasks);
}

// 获取语言扩展
async function getLanguageExtension(lang: string) {
  const langMap: Record<string, () => Promise<Extension>> = {
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

  // 自定义保存快捷键：若开启 formatOnSave 且当前语言有可用 LSP，则先异步
  // 请求格式化并应用 edits，完成后再调用 onSave。格式化失败不会阻塞保存。
  const saveKeymap = useMemo(
    () => keymap.of(
      onSave
        ? [
            {
              key: 'Mod-s',
              run: (view) => {
                const fp = filePathRef.current;
                const { formatOnSave } = useEditorSettingsStore.getState();
                if (formatOnSave && fp) {
                  void formatDocumentForFile(fp, language, view).finally(() => onSave());
                } else {
                  onSave();
                }
                return true;
              },
            },
          ]
        : [],
    ),
    [onSave, language]
  );

  // 初始化编辑器（组件通过 key 属性强制重新挂载，所以只需在挂载时执行一次）
  useEffect(() => {
    if (!containerRef.current) return;

    let cancelled = false;

    /**
     * 右键菜单上下文捕获：在 contextmenu 事件触发时，
     * 将当前编辑器的文件路径和选区位置写入 editorContextStore，
     * 供全局 SelectionContextMenu 读取并生成结构化引用。
     */
    function handleContextMenuCapture() {
      const view = viewRef.current;
      const currentPath = filePathRef.current;
      if (!view || !currentPath) return;

      const sel = view.state.selection.main;
      const doc = view.state.doc;

      const fromLine = doc.lineAt(sel.from);
      const toLine = doc.lineAt(sel.to);

      const workspace = useWorkspaceStore.getState().getCurrentWorkspace();
      let relativePath: string | null = null;
      if (workspace?.path) {
        const normalized = currentPath.replace(/\\/g, '/');
        const wsPath = workspace.path.replace(/\\/g, '/').replace(/\/$/, '');
        relativePath = normalized.startsWith(wsPath)
          ? normalized.slice(wsPath.length + 1)
          : normalized;
      }

      useEditorContextStore.getState().setSelectionContext({
        filePath: currentPath,
        relativePath,
        lineStart: fromLine.number,
        lineEnd: toLine.number,
        columnStart: sel.from - fromLine.from + 1,
        columnEnd: sel.to - toLine.from + 1,
      });
    }

    // 异步创建编辑器（需要加载语言扩展）
    const createEditor = async () => {
      // 检查缓冲区中是否有缓存的 EditorState
      const cachedState = filePath
        ? useFileEditorStore.getState().loadBuffer(filePath)?.editorState
        : null;

      if (cachedState && !cancelled && containerRef.current) {
        // 从缓存恢复：保留 undo 历史、光标位置、折叠状态
        log.debug('从缓存恢复 EditorState', { filePath });
        const view = new EditorView({
          state: cachedState,
          parent: containerRef.current,
        });
        viewRef.current = view;

        // 注册右键菜单上下文捕获
        view.dom.addEventListener('contextmenu', handleContextMenuCapture);

        // 检查是否有待跳转的行号
        applyPendingGoto(view);
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
        ...trailingWhitespaceHighlight,
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        crosshairCursor(),
        showLineNumbers ? lineNumbers() : [],
        highlightSelectionMatches(),
        history(),
        bracketMatching(),
        ...rainbowBrackets,
        closeBrackets(),
        indentOnInput(),
        foldGutter(),
        keymap.of(foldKeymap),
        EditorView.editable.of(!readOnly),
        wrapEnabled ? EditorView.lineWrapping : [],
        indentUnit.of('  '),
        indentGuides,
        indentGuideTheme,
        saveKeymap,
        keymap.of(defaultKeymap),
        keymap.of(historyKeymap),
        keymap.of(closeBracketsKeymap),
        keymap.of([
          { key: 'Alt-ArrowUp', run: addCursorAbove },
          { key: 'Alt-ArrowDown', run: addCursorBelow },
        ]),
        keymap.of(searchKeymap),
        keymap.of([{ key: 'Mod-g', run: gotoLine }]),
        zoomKeymap,
        // 不启用 lintGutter()：诊断已有行内波浪线 + 悬停提示呈现，
        // 独立 gutter 列在无诊断时是纯空白占位（与 VS Code 默认行为一致）
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

      // 加载 LSP 扩展（如果已配置该语言的 LSP 服务器）
      if (filePath && language) {
        try {
          // rootUri 优先使用当前工作区路径，回退到文件父目录
          const workspace = useWorkspaceStore.getState().getCurrentWorkspace();
          const rootPath = (workspace?.path
            ?? filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/')) || '/';
          const normalized = rootPath.replace(/\\/g, '/');
          const rootUri = normalized.startsWith('/')
            ? `file://${normalized}`
            : `file:///${normalized}`;

          const lspResult = await useLspStore.getState().activateForFile(
            filePath,
            language,
            rootUri,
          );

          if (lspResult && !cancelled) {
            extensions.push(...lspResult.extensions);
            log.debug('LSP extensions loaded', { filePath, language });
          }
        } catch (err) {
          // LSP 激活失败不影响编辑器基础功能
          log.warn('LSP activation skipped', { filePath, error: String(err) });
        }
      }

      // 收集插件注册的编辑器扩展（如 git gutter、inline diff 等）
      const pluginExtensions = editorExtensionRegistry.collectExtensions(filePath);
      if (pluginExtensions.length > 0) {
        extensions.push(...pluginExtensions);
        log.debug(`Plugin editor extensions loaded: ${pluginExtensions.length}`);
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

      // 注册右键菜单上下文捕获
      view.dom.addEventListener('contextmenu', handleContextMenuCapture);

      log.debug('Editor view created successfully');

      // 检查是否有待跳转的行号
      applyPendingGoto(view);
    };

    /**
     * 应用待跳转的行/列。支持 LSP 跨文件跳转的精确定位：
     * pendingGotoLine 是 1-indexed 行号，pendingGotoColumn 是 0-indexed 列。
     */
    function applyPendingGoto(view: EditorView) {
      const store = useFileEditorStore.getState();
      const pendingLine = store.pendingGotoLine;
      if (pendingLine === null) return;

      const doc = view.state.doc;
      if (pendingLine >= 1 && pendingLine <= doc.lines) {
        const line = doc.line(pendingLine);
        const col = store.pendingGotoColumn ?? 0;
        const anchor = Math.min(line.from + col, line.to);
        view.dispatch({
          selection: { anchor },
          effects: EditorView.scrollIntoView(anchor, { y: 'center' }),
        });
        view.focus();
        log.debug('跳转到行', { lineNumber: pendingLine, column: col });
      }
      store.setPendingGotoLine(null);
    }

    createEditor();

    // 清理函数：保存 EditorState 到缓冲区
    return () => {
      cancelled = true;
      if (viewRef.current) {
        // 移除右键菜单上下文捕获
        viewRef.current.dom.removeEventListener('contextmenu', handleContextMenuCapture);
        useEditorContextStore.getState().clearSelectionContext();
        // 保存 EditorState（保留 undo 历史、光标、折叠等）
        const currentPath = filePathRef.current;
        if (currentPath) {
          useFileEditorStore.getState().saveBufferEditorState(currentPath, viewRef.current.state);
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
