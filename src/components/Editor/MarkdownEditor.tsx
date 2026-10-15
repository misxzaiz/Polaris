/**
 * Markdown 编辑器组件
 * 支持编辑/预览/分屏模式切换，代码语法高亮，Mermaid 图表渲染
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { CodeMirrorEditor } from './Editor';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { MermaidDiagram } from '../Chat/common/MermaidDiagram';
import { splitMarkdownWithMermaid, type MarkdownPart } from '@/utils/markdown';
import { usePerformanceFlag } from '@/utils/performanceFeatures';
import { useViewStore } from '@/stores';
import hljs from '@/utils/highlight';

interface MarkdownEditorProps {
  /** 编辑器内容 */
  value: string;
  /** 内容变化回调 */
  onChange: (value: string) => void;
  /** 保存回调 */
  onSave?: () => void;
  /** 只读模式 */
  readOnly?: boolean;
}

/** 视图模式 */
type ViewMode = 'edit' | 'preview' | 'split';

/** TOC 标题项 */
interface TocHeading {
  level: number;
  text: string;
  id: string;
  /** 源码行号（1-indexed），用于联动定位编辑区 */
  line: number;
}

/** 从 Markdown 源码提取标题列表 */
function extractHeadings(content: string): TocHeading[] {
  const result: TocHeading[] = [];
  const lines = content.split('\n');
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo];
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      const text = match[2]
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/`(.+?)`/g, '$1')
        .replace(/\[(.+?)\]\(.+?\)/g, '$1')
        .replace(/~~(.+?)~~/g, '$1')
        .trim();
      result.push({ level: match[1].length, text, id: `toc-h-${result.length}`, line: lineNo + 1 });
    }
  }
  return result;
}

// 配置 marked
marked.setOptions({
  breaks: true,  // 支持 GFM 换行
  gfm: true,     // GitHub Flavored Markdown
});

/** Markdown 渲染（marked + DOMPurify） */
function formatContent(content: string): string {
  try {
    const raw = marked.parse(content) as string;
    return DOMPurify.sanitize(raw, {
      ALLOWED_TAGS: [
        'p', 'br', 'strong', 'em', 'code', 'pre', 'blockquote',
        'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'a', 'span', 'div', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
        'hr', 'img', 'input', 'del', 'sup', 'sub',
      ],
      ALLOWED_ATTR: ['class', 'href', 'target', 'rel', 'align', 'src', 'alt', 'title', 'id', 'type', 'checked', 'disabled'],
    });
  } catch {
    return content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
  }
}

export function MarkdownEditor({ value, onChange, onSave, readOnly = false }: MarkdownEditorProps) {
  // 默认预览模式：大多数情况下只读不改，打开即见渲染结果
  const [viewMode, setViewMode] = useState<ViewMode>('preview');
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  // 大纲默认展开；小屏（compact）默认收起，避免挤占窄窗口
  const [showToc, setShowToc] = useState(
    () => !useViewStore.getState().compactMode.isCompactMode
  );
  // 当前"正在阅读"的标题 id（预览滚动联动大纲高亮）
  const [activeTocId, setActiveTocId] = useState<string | null>(null);

  // 性能开关：mermaid 关闭时编辑器预览不自动加载 mermaid.js，显示"点击渲染"。
  const mermaidEnabled = usePerformanceFlag('mermaidDiagrams');

  const containerRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  // 编辑区滚动控制句柄（由 CodeMirrorEditor 写入）
  const editorScrollRef = useRef<{ setRatio: (r: number) => void; setLine: (l: number) => void } | null>(null);
  // 同步计数锁：程序化滚动期间置位，防双向事件反弹。
  // 用数字而非布尔，支持"编辑区滚→写预览→预览滚→写编辑区"这种
  // rAF 窗口内的嵌套事件（布尔会互相误吞）。
  const syncingRef = useRef(0);

  // 预览渲染
  const previewParts = useMemo(() => splitMarkdownWithMermaid(value), [value]);

  // TOC 目录
  const tocHeadings = useMemo(() => extractHeadings(value), [value]);

  // 代码高亮 + 为标题元素赋 ID（用于 TOC 跳转）+ 注入代码块复制按钮
  useEffect(() => {
    if (viewMode === 'edit' || !previewRef.current) return;
    const container = previewRef.current;

    // 代码高亮
    container.querySelectorAll('pre code').forEach((block) => {
      const el = block as HTMLElement;
      if (!el.dataset.highlighted) {
        hljs.highlightElement(el);
      }
    });

    // 为标题元素赋 ID
    const domHeadings = container.querySelectorAll('h1, h2, h3, h4, h5, h6');
    domHeadings.forEach((h, i) => { h.id = `toc-h-${i}`; });

    // 为代码块注入复制按钮
    container.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.md-editor-copy-btn')) return; // 已注入
      const codeText = pre.querySelector('code')?.textContent || '';
      const btn = document.createElement('button');
      btn.className = 'md-editor-copy-btn';
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      btn.title = '复制代码';
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(codeText);
          btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
          btn.title = '已复制';
          setTimeout(() => {
            btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
            btn.title = '复制代码';
          }, 2000);
        } catch { /* ignore */ }
      });
      pre.style.position = 'relative';
      pre.appendChild(btn);
    });
  }, [previewParts, viewMode]);

  // 分隔条拖拽
  useEffect(() => {
    if (!isDraggingSplit) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      setSplitRatio(Math.min(0.75, Math.max(0.25, ratio)));
    };
    const handleMouseUp = () => {
      setIsDraggingSplit(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingSplit]);

  const handleSplitDragStart = useCallback(() => {
    setIsDraggingSplit(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  // 大纲高亮：依据预览滚动位置选择"最接近视口顶端"的标题
  // 由预览滚动与编辑区滚动同步两处共用。
  const updateActiveTocId = useCallback((el: HTMLElement) => {
    const heads = Array.from(el.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    if (heads.length === 0) return;
    let current: Element | null = null;
    for (const h of heads) {
      const r = h.getBoundingClientRect();
      if (r.top <= 90) current = h; // 视口 90px 内最高者（含顶部工具栏偏移）
      else break;
    }
    const id = current?.getAttribute('id') ?? null;
    setActiveTocId((prev) => (prev !== id ? id : prev));
  }, []);

  const scrollToHeading = useCallback((id: string) => {
    setActiveTocId(id); // 点击后立即高亮，不等滚动事件
    const el = previewRef.current?.querySelector(`#${id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // 同步定位编辑区到对应源码行（split 模式下）
    if (viewMode === 'split' && editorScrollRef.current) {
      const toc = tocHeadings.find((h) => h.id === id);
      if (toc) editorScrollRef.current.setLine(toc.line);
    }
  }, [viewMode, tocHeadings]);

  // === 双向联动滚动：预览区 ↔ 编辑区（split 模式）===
  // 用滚动比例同步（左右内容行高不一定一致，比例映射最稳）。
  // syncingRef 作为互斥锁：程序化滚动时屏蔽对方的 scroll 事件，防止震荡。
  useEffect(() => {
    if (viewMode !== 'split') return;
    const preview = previewRef.current;
    if (!preview) return;

    const onPreviewScroll = () => {
      if (syncingRef.current > 0) return; // 程序化滚动中，忽略
      const el = preview;
      const max = el.scrollHeight - el.clientHeight;
      const ratio = max > 0 ? el.scrollTop / max : 0;
      // 回写编辑区：加锁防止编辑区 scroll 事件反弹回写导致抖动
      syncingRef.current += 1;
      editorScrollRef.current?.setRatio(ratio);
      requestAnimationFrame(() => {
        syncingRef.current = Math.max(0, syncingRef.current - 1);
      });
      // 预览滚动时高亮当前章节
      updateActiveTocId(el);
    };

    preview.addEventListener('scroll', onPreviewScroll, { passive: true });
    updateActiveTocId(preview); // 初始高亮
    return () => preview.removeEventListener('scroll', onPreviewScroll);
  }, [viewMode, previewParts, updateActiveTocId]); // previewParts 变化（内容重渲染）后重建监听，重新计算边界

  const showEditor = viewMode === 'edit' || viewMode === 'split';
  const showPreview = viewMode === 'preview' || viewMode === 'split';

  return (
    <div className="flex flex-col h-full">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border-subtle bg-background-elevated">
        <div className="flex items-center gap-0.5 bg-background-base rounded-md p-0.5">
          <button
            className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${
              viewMode === 'split'
                ? 'bg-primary text-white shadow-sm'
                : 'text-text-tertiary hover:text-text-primary'
            }`}
            onClick={() => setViewMode('split')}
            title="分屏模式"
          >
            分屏
          </button>
          <button
            className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${
              viewMode === 'edit'
                ? 'bg-primary text-white shadow-sm'
                : 'text-text-tertiary hover:text-text-primary'
            }`}
            onClick={() => setViewMode('edit')}
            title="编辑模式"
          >
            编辑
          </button>
          <button
            className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${
              viewMode === 'preview'
                ? 'bg-primary text-white shadow-sm'
                : 'text-text-tertiary hover:text-text-primary'
            }`}
            onClick={() => setViewMode('preview')}
            title="预览模式"
          >
            预览
          </button>
        </div>

        <div className="flex-1" />

        {showPreview && tocHeadings.length > 0 && (
          <button
            className={`px-2 py-1 text-xs rounded-md border transition-all ${
              showToc
                ? 'border-primary/30 bg-primary/10 text-primary'
                : 'border-border-subtle text-text-tertiary hover:text-text-primary'
            }`}
            onClick={() => setShowToc(!showToc)}
            title="目录"
          >
            大纲
          </button>
        )}
      </div>

      {/* 内容区域 */}
      <div ref={containerRef} className="flex-1 overflow-hidden flex">
        {/* 编辑面板 */}
        {showEditor && (
          <div
            className="overflow-hidden"
            style={viewMode === 'split' ? { width: `${splitRatio * 100}%` } : { flex: 1 }}
          >
            <CodeMirrorEditor
              value={value}
              language="markdown"
              onChange={onChange}
              onSave={onSave}
              readOnly={readOnly}
              onScrollRatio={(ratio) => {
                // 编辑区滚动 → 同步预览区（比例映射）
                const preview = previewRef.current;
                if (!preview || syncingRef.current > 0) return;
                const max = preview.scrollHeight - preview.clientHeight;
                if (max > 0) {
                  syncingRef.current += 1;
                  preview.scrollTop = ratio * max;
                  // 同步后更新大纲高亮（预览位置已变）
                  requestAnimationFrame(() => {
                    syncingRef.current = Math.max(0, syncingRef.current - 1);
                    if (previewRef.current) updateActiveTocId(previewRef.current);
                  });
                }
              }}
              scrollControllerRef={editorScrollRef}
            />
          </div>
        )}

        {/* 分隔条 */}
        {viewMode === 'split' && (
          <div
            className={`w-[3px] cursor-col-resize flex-shrink-0 transition-colors ${
              isDraggingSplit ? 'bg-primary' : 'bg-border-subtle/40 hover:bg-primary/60'
            }`}
            onMouseDown={handleSplitDragStart}
          />
        )}

        {/* 预览区域（含 TOC） */}
        {showPreview && (
          <div
            className="flex overflow-hidden"
            style={viewMode === 'split' ? { width: `${(1 - splitRatio) * 100}%` } : { flex: 1 }}
          >
            {/* TOC 目录侧边栏 */}
            {showToc && tocHeadings.length > 0 && (
              <div className="w-[160px] flex-shrink-0 border-r border-border-subtle bg-background-elevated overflow-y-auto p-3">
                <div className="text-[10px] text-text-quaternary uppercase tracking-wider mb-2">目录</div>
                {tocHeadings.map((h) => (
                  <button
                    key={h.id}
                    className={`block text-[11px] transition-colors truncate w-full text-left py-0.5 ${
                      activeTocId === h.id
                        ? 'text-primary font-medium'
                        : 'text-text-tertiary hover:text-primary'
                    }`}
                    style={{ paddingLeft: `${(h.level - 1) * 12}px` }}
                    onClick={() => scrollToHeading(h.id)}
                    title={h.text}
                  >
                    {h.text}
                  </button>
                ))}
              </div>
            )}

            {/* 预览内容 */}
            <div
              ref={previewRef}
              className="flex-1 overflow-auto bg-background-base"
            >
              <div className="max-w-none px-6 py-4 prose prose-invert prose-sm">
                {previewParts.map((part: MarkdownPart, index: number) => {
                  if (part.type === 'mermaid') {
                    return (
                      <div key={`mermaid-${part.id || index}`}>
                        <MermaidDiagram
                          code={part.content}
                          id={part.id || `mermaid-${index}`}
                          enabled={mermaidEnabled}
                        />
                      </div>
                    );
                  }
                  const html = formatContent(part.content);
                  return (
                    <div
                      key={`text-${index}`}
                      dangerouslySetInnerHTML={{ __html: html }}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
