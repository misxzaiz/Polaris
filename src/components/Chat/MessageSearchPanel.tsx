/**
 * 消息搜索面板组件
 *
 * 功能：
 * - 搜索当前会话消息内容
 * - 高亮匹配关键词
 * - 上一个/下一个导航
 * - 显示匹配计数
 * - Ctrl+F / Cmd+F 触发
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Search, X, ChevronUp, ChevronDown } from 'lucide-react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';

export interface SearchMatch {
  messageId: string;
  matchIndex: number;
}

interface MessageSearchPanelProps {
  /** 是否显示 */
  visible: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 搜索关键词 */
  searchQuery: string;
  /** 更新搜索关键词 */
  onSearchQueryChange: (query: string) => void;
  /** 当前匹配索引 */
  currentMatchIndex: number;
  /** 总匹配数 */
  totalMatches: number;
  /** 跳转到上一个匹配 */
  onPrevious: () => void;
  /** 跳转到下一个匹配 */
  onNext: () => void;
}

export function MessageSearchPanel({
  visible,
  onClose,
  searchQuery,
  onSearchQueryChange,
  currentMatchIndex,
  totalMatches,
  onPrevious,
  onNext,
}: MessageSearchPanelProps) {
  const { t } = useTranslation('chat');
  const inputRef = useRef<HTMLInputElement>(null);

  // 显示时自动聚焦
  useEffect(() => {
    if (visible && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [visible]);

  // 键盘事件处理
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'Enter') {
      if (e.shiftKey) {
        onPrevious();
      } else {
        onNext();
      }
    } else if (e.key === 'F3') {
      e.preventDefault();
      if (e.shiftKey) {
        onPrevious();
      } else {
        onNext();
      }
    }
  }, [onClose, onPrevious, onNext]);

  if (!visible) return null;

  return (
    <div
      className={clsx(
        'absolute top-2 right-4 z-50',
        'bg-background-elevated/95 backdrop-blur-sm',
        'border border-border rounded-lg shadow-lg',
        'flex items-center gap-2 p-2',
        'animate-in fade-in zoom-in-95 duration-150'
      )}
    >
      {/* 搜索图标 */}
      <Search className="w-4 h-4 text-text-tertiary shrink-0" />

      {/* 输入框 */}
      <input
        ref={inputRef}
        type="text"
        value={searchQuery}
        onChange={(e) => onSearchQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('search.placeholder')}
        className="w-48 px-2 py-1 text-sm bg-transparent border-none outline-none text-text-primary placeholder:text-text-tertiary"
      />

      {/* 匹配计数 */}
      <span className="text-xs text-text-tertiary min-w-[40px] text-center">
        {totalMatches > 0 ? `${currentMatchIndex + 1}/${totalMatches}` : t('search.noMatch')}
      </span>

      {/* 上一个 */}
      <button
        onClick={onPrevious}
        disabled={totalMatches === 0}
        className={clsx(
          'p-1 rounded transition-colors',
          totalMatches > 0
            ? 'hover:bg-background-hover text-text-secondary'
            : 'text-text-muted cursor-not-allowed'
        )}
        title={t('search.previous')}
      >
        <ChevronUp className="w-4 h-4" />
      </button>

      {/* 下一个 */}
      <button
        onClick={onNext}
        disabled={totalMatches === 0}
        className={clsx(
          'p-1 rounded transition-colors',
          totalMatches > 0
            ? 'hover:bg-background-hover text-text-secondary'
            : 'text-text-muted cursor-not-allowed'
        )}
        title={t('search.next')}
      >
        <ChevronDown className="w-4 h-4" />
      </button>

      {/* 关闭按钮 */}
      <button
        onClick={onClose}
        className="p-1 rounded hover:bg-background-hover text-text-tertiary hover:text-text-primary transition-colors"
        title={t('search.close')}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

/**
 * 高亮文本中的关键词
 * @param text 原始文本
 * @param query 搜索关键词
 * @returns React 节点
 */
export function highlightSearchMatch(text: string, query: string): React.ReactNode {
  if (!query || query.trim() === '') {
    return text;
  }

  // 转义正则特殊字符
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escapedQuery})`, 'gi');
  const parts = text.split(regex);

  if (parts.length === 1) {
    return text;
  }

  return parts.map((part, index) => {
    // 检查是否为匹配部分（忽略大小写）
    if (part.toLowerCase() === query.toLowerCase()) {
      return (
        <mark
          key={index}
          className="bg-warning/40 text-inherit rounded px-0.5"
        >
          {part}
        </mark>
      );
    }
    return part;
  });
}

/**
 * 搜索 Hook
 * 在消息中搜索关键词并返回匹配结果
 */
export function useMessageSearch(messages: Array<{ id: string; content?: string; blocks?: Array<{ type: string; content?: string }> }>) {
  const [searchQuery, setSearchQuery] = useState('');
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [isSearchVisible, setIsSearchVisible] = useState(false);

  // 获取所有消息的文本内容
  const messageTexts = useMemo(() => {
    return messages.map(msg => {
      // 用户消息
      if (msg.content) {
        return { id: msg.id, text: msg.content };
      }
      // 助手消息（blocks）
      if (msg.blocks) {
        const text = msg.blocks
          .filter(block => block.type === 'text' || block.type === 'thinking')
          .map(block => (block as any).content || '')
          .join(' ');
        return { id: msg.id, text };
      }
      return { id: msg.id, text: '' };
    });
  }, [messages]);

  // 搜索匹配结果
  const searchMatches = useMemo((): SearchMatch[] => {
    if (!searchQuery.trim()) return [];

    const matches: SearchMatch[] = [];
    const lowerQuery = searchQuery.toLowerCase();

    messageTexts.forEach(({ id, text }) => {
      const lowerText = text.toLowerCase();
      let startIndex = 0;
      let matchIndex = 0;

      while (true) {
        const index = lowerText.indexOf(lowerQuery, startIndex);
        if (index === -1) break;

        matches.push({
          messageId: id,
          matchIndex: matchIndex++,
        });
        startIndex = index + 1;
      }
    });

    return matches;
  }, [messageTexts, searchQuery]);

  // 总匹配数
  const totalMatches = searchMatches.length;

  // 当前匹配的消息 ID
  const currentMatchMessageId = useMemo(() => {
    if (searchMatches.length === 0) return null;
    const match = searchMatches[currentMatchIndex];
    return match?.messageId || null;
  }, [searchMatches, currentMatchIndex]);

  // 跳转到上一个匹配
  const goToPrevious = useCallback(() => {
    if (totalMatches === 0) return;
    setCurrentMatchIndex(prev => (prev - 1 + totalMatches) % totalMatches);
  }, [totalMatches]);

  // 跳转到下一个匹配
  const goToNext = useCallback(() => {
    if (totalMatches === 0) return;
    setCurrentMatchIndex(prev => (prev + 1) % totalMatches);
  }, [totalMatches]);

  // 打开搜索
  const openSearch = useCallback(() => {
    setIsSearchVisible(true);
  }, []);

  // 关闭搜索
  const closeSearch = useCallback(() => {
    setIsSearchVisible(false);
    setSearchQuery('');
    setCurrentMatchIndex(0);
  }, []);

  // 重置匹配索引（当搜索词变化时）
  useEffect(() => {
    setCurrentMatchIndex(0);
  }, [searchQuery]);

  return {
    searchQuery,
    setSearchQuery,
    isSearchVisible,
    openSearch,
    closeSearch,
    currentMatchIndex,
    totalMatches,
    currentMatchMessageId,
    goToPrevious,
    goToNext,
  };
}
