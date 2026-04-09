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
import { useFileExplorerStore, useFileEditorStore } from '../../stores';
import { searchFileContents, type ContentMatch } from '../../services/tauri';
import { Search, Loader2, FileText, FileSearch } from 'lucide-react';
import type { FileInfo } from '../../types';

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
  const parts = lower.split(/[._\-]/);
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

export function FileSearchModal({ onClose }: FileSearchModalProps) {
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('content');
  const [selectedIndex, setSelectedIndex] = useState(0);

  // 文件名搜索状态
  const [deepResults, setDeepResults] = useState<FileInfo[] | null>(null);
  const [isDeepSearching, setIsDeepSearching] = useState(false);

  // 内容搜索状态
  const [contentResults, setContentResults] = useState<ContentMatch[]>([]);
  const [isContentSearching, setIsContentSearching] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchAbort = useRef<AbortController | null>(null);

  const { file_tree, current_path, deep_search, revealPath } = useFileExplorerStore();
  const openFileAtLine = useFileEditorStore(s => s.openFileAtLine);

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
  const results = searchMode === 'filename' ? filenameResults : contentResults;
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

  // 滚动选中项到可见区域
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('[data-file-item]');
    const selected = items[selectedIndex] as HTMLElement;
    selected?.scrollIntoView({ block: 'nearest' });
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
      setContentResults([]);
      setIsContentSearching(false);
      return;
    }

    searchTimer.current = setTimeout(async () => {
      setIsContentSearching(true);
      const abort = new AbortController();
      searchAbort.current = abort;

      try {
        const results = await searchFileContents(q, current_path, {}, 100);
        if (!abort.signal.aborted) {
          setContentResults(results);
        }
      } catch {
        // 搜索失败，忽略
      } finally {
        if (!abort.signal.aborted) {
          setIsContentSearching(false);
        }
      }
    }, 300);

    return () => {
      clearTimeout(searchTimer.current);
    };
  }, [query, searchMode, current_path]);

  // 选中文件名结果：打开编辑器或展开文件夹
  const handleFilenameSelect = useCallback((file: FileInfo) => {
    if (file.is_dir) {
      // 文件夹：展开文件浏览器并定位
      revealPath(file.path);
      onClose();
    } else {
      // 文件：打开编辑器
      const openFile = useFileEditorStore.getState().openFile;
      openFile(file.path, file.name);
      onClose();
    }
  }, [revealPath, onClose]);

  // 选中内容搜索结果：打开编辑器并跳转到行号
  const handleContentSelect = useCallback((match: ContentMatch) => {
    openFileAtLine(match.fullPath, match.name, match.lineNumber);
    onClose();
  }, [openFileAtLine, onClose]);

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
        setSelectedIndex(i => Math.min(i + 1, results.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
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

  // 点击背景关闭
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-start justify-center z-50 pt-[12vh]"
      onClick={handleBackdropClick}
    >
      <div
        className="bg-background-elevated rounded-xl w-full max-w-lg border border-border shadow-glow overflow-hidden animate-in fade-in zoom-in-95 duration-150"
        onKeyDown={handleKeyDown}
      >
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
              const relPath = getRelativePath(file.path, current_path);
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
                  key={`${match.fullPath}:${match.lineNumber}`}
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
          {searchMode === 'content' && contentResults.length > 0 && (
            <span className="ml-auto">{contentResults.length} 个匹配</span>
          )}
        </div>
      </div>
    </div>
  );
}
