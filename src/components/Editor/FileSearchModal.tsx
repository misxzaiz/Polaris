/**
 * 文件搜索模态框 — Shift+Ctrl+R 触发
 *
 * 功能：
 * - 模态搜索框，支持文件名搜索和内容搜索两种模式
 * - 键盘导航（↑↓ 选择，Enter 打开，Escape 关闭）
 * - 文件名搜索：基于已加载文件树 + 深度搜索
 * - 内容搜索：搜索文件内容并定位到具体行号
 */

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { FileIcon } from '../FileExplorer/FileIcon';
import { useFileExplorerStore, useFileEditorStore } from '@/stores';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useOverlayStore } from '@/stores/overlayStore';
import { searchFileContentsDetailed, type ContentMatch, type ContentSearchResponse } from '@/services/tauri';
import { Search, Loader2, FileText, FileSearch, Pin, PinOff, X } from 'lucide-react';
import type { FileInfo } from '@/types';

interface FileSearchModalProps {
  onClose: () => void;
}

/** 搜索模式 */
type SearchMode = 'filename' | 'content';

/** 递归收集已加载文件树中的所有文件 */
function collectAllFiles(nodes: FileInfo[]): FileInfo[] {
  const results: FileInfo[] = [];
  for (const node of nodes) {
    if (!node.is_dir) {
      results.push(node);
    }
    if (node.children) {
      results.push(...collectAllFiles(node.children));
    }
  }
  return results;
}

/** 获取相对于工作区根的路径 */
function getRelativePath(fullPath: string, basePath: string): string {
  const normalizedBase = basePath.replace(/\\/g, '/');
  const normalizedFull = fullPath.replace(/\\/g, '/');
  if (normalizedFull.startsWith(normalizedBase + '/')) {
    return normalizedFull.slice(normalizedBase.length + 1);
  }
  if (normalizedFull.startsWith(normalizedBase)) {
    return normalizedFull.slice(normalizedBase.length);
  }
  return fullPath;
}

/** 提取目录部分 */
function getDirectoryPath(relativePath: string): string {
  const lastSep = relativePath.lastIndexOf('/');
  return lastSep >= 0 ? relativePath.substring(0, lastSep) : '';
}

/** 计算匹配得分（用于排序） */
function matchScore(name: string, query: string): number {
  const lower = name.toLowerCase();
  const q = query.toLowerCase();
  if (lower === q) return 4;          // 完全匹配
  if (lower.startsWith(q)) return 3;  // 前缀匹配
  if (lower.endsWith(q)) return 2;    // 后缀匹配
  // 检查驼峰/下划线/短横线首字母匹配
  const parts = lower.split(/[._-]/);
  if (parts.some(p => p.startsWith(q))) return 1;
  return 0;                           // 包含匹配
}

/** 高亮匹配文本 */
function HighlightMatch({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;

  return (
    <>
      {text.slice(0, idx)}
      <span className="text-primary font-semibold">{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  );
}

/** 高亮行内匹配 */
function HighlightLineMatch({ line, start, end }: { line: string; start: number; end: number }) {
  return (
    <>
      {line.slice(0, start)}
      <span className="bg-primary/30 text-primary font-semibold">{line.slice(start, end)}</span>
      {line.slice(end)}
    </>
  );
}

const MAX_RESULTS = 50;
const CONTENT_SEARCH_MAX_RESULTS = 300;

type ContentSearchState = Pick<
  ContentSearchResponse,
  'matches' | 'truncated' | 'scannedFiles' | 'matchedFiles' | 'skippedFiles' | 'elapsedMs' | 'root' | 'maxResults'
>;

const EMPTY_CONTENT_SEARCH: ContentSearchState = {
  matches: [],
  truncated: false,
  scannedFiles: 0,
  matchedFiles: 0,
  skippedFiles: 0,
  elapsedMs: 0,
  root: '',
  maxResults: CONTENT_SEARCH_MAX_RESULTS,
};

export function FileSearchModal({ onClose }: FileSearchModalProps) {
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('content');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const pinned = useOverlayStore(s => s.fileSearchPinned);
  const setPinned = useOverlayStore(s => s.setFileSearchPinned);

  // 浮窗位置（钉住时用）。默认右上角，贴近模态的居中位置
  const [pos, setPos] = useState(() => {
    if (typeof window !== 'undefined') {
      return { x: Math.round((window.innerWidth - 480) / 2), y: Math.round(window.innerHeight * 0.12) };
    }
    return { x: 80, y: 80 };
  });
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // 文件名搜索状态
  const [deepResults, setDeepResults] = useState<FileInfo[] | null>(null);
  const [isDeepSearching, setIsDeepSearching] = useState(false);

  // 内容搜索状态
  const [contentSearch, setContentSearch] = useState<ContentSearchState>(EMPTY_CONTENT_SEARCH);
  const [isContentSearching, setIsContentSearching] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchAbort = useRef<AbortController | null>(null);
  const contentSearchSeq = useRef(0);
  // 标记是否为键盘导航触发，区分鼠标悬停（鼠标悬停不触发 scrollIntoView）
  const isKeyboardNavigationRef = useRef(false);

  const { file_tree, current_path, deep_search, revealPath } = useFileExplorerStore();
  const openFileAtLine = useFileEditorStore(s => s.openFileAtLine);
  const viewingWorkspacePath = useWorkspaceStore(s => s.getViewingWorkspace()?.path ?? null);
  const currentWorkspacePath = useWorkspaceStore(s => s.getCurrentWorkspace()?.path ?? null);
  const searchRoot = viewingWorkspacePath ?? currentWorkspacePath ?? current_path;

  // 从已加载的文件树中收集所有文件
  const loadedFiles = useMemo(
    () => collectAllFiles(file_tree),
    [file_tree]
  );

  // 文件名搜索结果
  const filenameResults = useMemo(() => {
    const source = deepResults ?? loadedFiles;
    if (!query.trim()) return source.slice(0, MAX_RESULTS);

    const q = query.toLowerCase().trim();
    return source
      .filter(f => f.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const scoreA = matchScore(a.name, q);
        const scoreB = matchScore(b.name, q);
        if (scoreA !== scoreB) return scoreB - scoreA;
        return a.name.localeCompare(b.name);
      })
      .slice(0, MAX_RESULTS);
  }, [loadedFiles, deepResults, query]);

  // 当前模式的结果
  const results = searchMode === 'filename' ? filenameResults : contentSearch.matches;
  const isLoading = searchMode === 'filename' ? isDeepSearching : isContentSearching;

  // 查询或模式变更时重置选中索引
  useEffect(() => {
    setSelectedIndex(0);
  }, [results.length, query, searchMode]);

  // 自动聚焦输入框
  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, []);

  // 拖拽浮窗（钉住时）：直接操作 DOM 避免重渲染
  useEffect(() => {
    if (!pinned) return;
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      const el = panelRef.current;
      if (!d || !el) return;
      el.style.left = Math.max(0, d.ox + (e.clientX - d.sx)) + 'px';
      el.style.top = Math.max(0, d.oy + (e.clientY - d.sy)) + 'px';
    };
    const onUp = () => {
      const el = panelRef.current;
      if (el && dragRef.current) {
        setPos({ x: parseInt(el.style.left || '0', 10), y: parseInt(el.style.top || '0', 10) });
      }
      dragRef.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [pinned]);

  // 滚动选中项到可见区域（仅键盘导航时触发，鼠标悬停不触发）
  useEffect(() => {
    // 非键盘导航不触发，避免鼠标悬停或结果更新时产生抖动
    if (!isKeyboardNavigationRef.current) return;
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('[data-file-item]');
    const selected = items[selectedIndex] as HTMLElement;
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
      // 重置标记
      isKeyboardNavigationRef.current = false;
    }
  }, [selectedIndex]);

  // 文件名深度搜索
  useEffect(() => {
    if (searchMode !== 'filename') return;

    clearTimeout(searchTimer.current);
    searchAbort.current?.abort();
    searchAbort.current = null;

    const q = query.trim();
    if (!q) {
      setDeepResults(null);
      setIsDeepSearching(false);
      return;
    }

    searchTimer.current = setTimeout(async () => {
      setIsDeepSearching(true);
      const abort = new AbortController();
      searchAbort.current = abort;

      try {
        const results = await deep_search(q);
        if (!abort.signal.aborted) {
          setDeepResults(results);
        }
      } catch {
        // 搜索被取消或失败，忽略
      } finally {
        if (!abort.signal.aborted) {
          setIsDeepSearching(false);
        }
      }
    }, 300);

    return () => {
      clearTimeout(searchTimer.current);
    };
  }, [query, searchMode, deep_search]);

  // 内容搜索
  useEffect(() => {
    if (searchMode !== 'content') return;

    clearTimeout(searchTimer.current);
    searchAbort.current?.abort();
    searchAbort.current = null;

    const q = query.trim();
    if (!q) {
      setContentSearch(EMPTY_CONTENT_SEARCH);
      setIsContentSearching(false);
      return;
    }

    if (!searchRoot) {
      setContentSearch(EMPTY_CONTENT_SEARCH);
      setIsContentSearching(false);
      return;
    }

    const seq = ++contentSearchSeq.current;

    searchTimer.current = setTimeout(async () => {
      setIsContentSearching(true);
      const abort = new AbortController();
      searchAbort.current = abort;

      try {
        const response = await searchFileContentsDetailed(
          q,
          searchRoot,
          { caseSensitive: false, wholeWord: false },
          CONTENT_SEARCH_MAX_RESULTS,
        );
        if (!abort.signal.aborted && seq === contentSearchSeq.current) {
          setContentSearch(response);
        }
      } catch {
        // 搜索失败，忽略
      } finally {
        if (!abort.signal.aborted && seq === contentSearchSeq.current) {
          setIsContentSearching(false);
        }
      }
    }, 300);

    return () => {
      clearTimeout(searchTimer.current);
    };
  }, [query, searchMode, searchRoot]);

  // 选中文件名结果：打开编辑器或展开文件夹
  const handleFilenameSelect = useCallback((file: FileInfo) => {
    if (file.is_dir) {
      // 文件夹：展开文件浏览器并定位
      revealPath(file.path);
    } else {
      // 文件：打开编辑器
      const openFile = useFileEditorStore.getState().openFile;
      openFile(file.path, file.name);
    }
    if (!pinned) onClose();
  }, [revealPath, onClose, pinned]);

  // 选中内容搜索结果：打开编辑器并跳转到行号
  const handleContentSelect = useCallback((match: ContentMatch) => {
    openFileAtLine(match.fullPath, match.name, match.lineNumber);
    if (!pinned) onClose();
  }, [openFileAtLine, onClose, pinned]);

  // 键盘事件处理
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Tab 切换模式
    if (e.key === 'Tab') {
      e.preventDefault();
      setSearchMode(mode => mode === 'filename' ? 'content' : 'filename');
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        // 标记为键盘导航，触发 scrollIntoView
        isKeyboardNavigationRef.current = true;
        setSelectedIndex(i => Math.min(i + 1, results.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        // 标记为键盘导航，触发 scrollIntoView
        isKeyboardNavigationRef.current = true;
        setSelectedIndex(i => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (searchMode === 'filename') {
          const file = results[selectedIndex] as FileInfo;
          if (file) handleFilenameSelect(file);
        } else {
          const match = results[selectedIndex] as ContentMatch;
          if (match) handleContentSelect(match);
        }
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  }, [results, selectedIndex, searchMode, handleFilenameSelect, handleContentSelect, onClose]);

  // 点击背景关闭（钉住时无背景层，不会触发）
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget && !pinned) {
      onClose();
    }
  }, [onClose, pinned]);

  // 标题栏拖拽启动
  const startDrag = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    if (e.button !== 0) return;
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'move';
  }, [pos.x, pos.y]);

  // 共享内容（模式切换 + 搜索框 + 结果列表 + 底部提示）
  const modalContent = (
    <>
      {/* 模式切换 */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-border">
        <button
          className={`flex items-center gap-1.5 px-3 py-1 rounded text-sm transition-colors ${
            searchMode === 'content'
              ? 'bg-primary/20 text-primary'
              : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'
          }`}
          onClick={() => setSearchMode('content')}
        >
          <FileSearch className="w-3.5 h-3.5" />
          内容
        </button>
        <button
          className={`flex items-center gap-1.5 px-3 py-1 rounded text-sm transition-colors ${
            searchMode === 'filename'
              ? 'bg-primary/20 text-primary'
              : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'
          }`}
          onClick={() => setSearchMode('filename')}
        >
          <FileText className="w-3.5 h-3.5" />
          文件名
        </button>
      </div>

      {/* 搜索输入框 */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Search className="w-4 h-4 text-text-tertiary flex-shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={searchMode === 'filename' ? '搜索文件名...' : '搜索文件内容...'}
          className="flex-1 bg-transparent text-text-primary placeholder:text-text-tertiary focus:outline-none text-sm"
          spellCheck={false}
        />
        {isLoading && (
          <Loader2 className="w-4 h-4 text-text-tertiary animate-spin flex-shrink-0" />
        )}
        <kbd className="text-[10px] text-text-tertiary bg-background-surface px-1.5 py-0.5 rounded border border-border font-mono">
          Esc
        </kbd>
      </div>

      {/* 结果列表 */}
      <div ref={listRef} className="max-h-[40vh] overflow-y-auto">
        {results.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-text-tertiary">
            <Search className="w-6 h-6 mb-2 opacity-50" />
            <div className="text-sm">
              {query.trim()
                ? (searchMode === 'filename' ? '未找到匹配的文件' : '未找到匹配的内容')
                : (searchMode === 'filename' ? '工作区无文件' : '输入关键词搜索文件内容')}
            </div>
          </div>
        ) : searchMode === 'filename' ? (
          // 文件名搜索结果
          (results as FileInfo[]).map((file, index) => {
            const relPath = getRelativePath(file.path, searchRoot);
            const dirPath = getDirectoryPath(relPath);
            const isSelected = index === selectedIndex;

            return (
              <div
                key={file.path}
                data-file-item
                className={`flex items-center gap-2 px-4 py-1.5 cursor-pointer transition-colors ${
                  isSelected
                    ? 'bg-primary/10 text-text-primary'
                    : 'text-text-primary hover:bg-background-hover'
                }`}
                onClick={() => handleFilenameSelect(file)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <FileIcon file={file} className="w-4 h-4 flex-shrink-0" />
                <div className="flex-1 min-w-0 flex items-baseline gap-2">
                  <span className="text-sm truncate">
                    <HighlightMatch text={file.name} query={query} />
                  </span>
                  {dirPath && (
                    <span className="text-xs text-text-tertiary truncate flex-shrink min-w-0">
                      {dirPath}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        ) : (
          // 内容搜索结果
          (results as ContentMatch[]).map((match, index) => {
            const isSelected = index === selectedIndex;

            return (
              <div
                key={`${match.fullPath}:${match.lineNumber}:${match.matchStart}:${match.matchEnd}:${index}`}
                data-file-item
                className={`px-4 py-2 cursor-pointer transition-colors ${
                  isSelected
                    ? 'bg-primary/10 text-text-primary'
                    : 'text-text-primary hover:bg-background-hover'
                }`}
                onClick={() => handleContentSelect(match)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                {/* 文件名和行号 */}
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-sm font-medium truncate">
                    <HighlightMatch text={match.name} query={query} />
                  </span>
                  <span className="text-xs text-primary font-mono">
                    :{match.lineNumber}
                  </span>
                  <span className="text-xs text-text-tertiary truncate flex-1 min-w-0">
                    {match.relativePath}
                  </span>
                </div>
                {/* 匹配行内容 */}
                <div className="text-xs text-text-secondary font-mono truncate bg-background-surface px-2 py-0.5 rounded">
                  <HighlightLineMatch
                    line={match.matchedLine}
                    start={match.matchStart}
                    end={match.matchEnd}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 底部提示 */}
      <div className="px-4 py-1.5 border-t border-border text-[10px] text-text-tertiary flex items-center gap-3">
        <span>Tab 切换模式</span>
        <span>↑↓ 导航</span>
        <span>↵ 打开</span>
        <span>Esc 关闭</span>
        {searchMode === 'filename' && deepResults !== null && (
          <span className="ml-auto">深度搜索: {deepResults.length} 个结果</span>
        )}
        {searchMode === 'content' && contentSearch.matches.length > 0 && (
          <span className={`ml-auto ${contentSearch.truncated ? 'text-yellow-500' : ''}`}>
            {contentSearch.truncated
              ? `显示前 ${contentSearch.matches.length}/${contentSearch.maxResults} 个匹配，结果已截断，请缩小关键词`
              : `${contentSearch.matches.length} 个匹配 · 扫描 ${contentSearch.scannedFiles} 文件 · ${contentSearch.elapsedMs}ms`}
          </span>
        )}
      </div>
    </>
  );

  if (pinned) {
    // 钉住：无遮罩浮窗，可拖拽，选中不关闭
    return (
      <div
        ref={panelRef}
        className="fixed z-popover bg-background-elevated rounded-xl border border-primary/40 shadow-glow overflow-hidden flex flex-col"
        style={{ left: pos.x, top: pos.y, width: 480, maxHeight: '80vh' }}
        onKeyDown={handleKeyDown}
      >
        {/* 标题栏（拖拽手柄） */}
        <div
          className="flex items-center justify-between px-4 py-2 border-b border-border bg-background-surface cursor-move select-none"
          onMouseDown={startDrag}
        >
          <span className="text-sm text-text-secondary flex items-center gap-2">
            <Search className="w-3.5 h-3.5 text-primary" />
            文件搜索
          </span>
          <div className="flex items-center gap-1">
            <button
              className="w-7 h-7 flex items-center justify-center text-text-tertiary hover:text-primary hover:bg-background-hover rounded"
              onClick={() => setPinned(false)}
              title="取消钉住"
            >
              <PinOff className="w-4 h-4" />
            </button>
            <button
              className="w-7 h-7 flex items-center justify-center text-text-tertiary hover:text-red-400 hover:bg-background-hover rounded"
              onClick={onClose}
              title="关闭"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        {modalContent}
      </div>
    );
  }

  // 未钉住：原模态行为
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-start justify-center z-modal pt-[12vh]"
      onClick={handleBackdropClick}
    >
      <div
        ref={modalRef}
        className="bg-background-elevated rounded-xl w-full max-w-lg border border-border shadow-glow overflow-hidden animate-dialog-in"
        onKeyDown={handleKeyDown}
      >
        {/* 钉住按钮 */}
        <div className="flex justify-end px-4 py-1.5 border-b border-border bg-background-surface">
          <button
            className="w-7 h-7 flex items-center justify-center text-text-tertiary hover:text-primary hover:bg-background-hover rounded"
            onClick={() => {
              // 读取当前模态面板位置作为浮窗初始坐标，避免位置跳变
              const rect = modalRef.current?.getBoundingClientRect();
              if (rect) setPos({ x: Math.round(rect.left), y: Math.round(rect.top) });
              setPinned(true);
            }}
            title="钉住 → 转为可拖拽浮窗"
          >
            <Pin className="w-4 h-4" />
          </button>
        </div>
        {modalContent}
      </div>
    </div>
  );
}
