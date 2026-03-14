/**
 * 选中文本右键菜单组件
 *
 * 支持功能：
 * - 复制选中文本
 * - 搜索（外部浏览器）
 * - 翻译（百度翻译）- 显示结果
 * - 复制引用（Markdown 格式）
 * - 引用问 AI（选中文本作为上下文）
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useTranslateStore, useConfigStore, useViewStore, useEventChatStore, useWorkspaceStore } from '../../stores';
import { baiduTranslate } from '../../services/tauri';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Copy, Search, Languages, Quote, MessageSquare, Check, X, Send, Loader2 } from 'lucide-react';

interface Position {
  x: number;
  y: number;
}

interface SelectionInfo {
  text: string;
  position: Position;
}

type MenuMode = 'menu' | 'translateResult' | 'askAIModal';

function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fa5]/.test(text);
}

export function SelectionContextMenu() {
  const { t } = useTranslation('translate');
  const { t: tCommon } = useTranslation('common');

  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<MenuMode>('menu');
  const [translatedText, setTranslatedText] = useState<string>('');
  const [isTranslating, setIsTranslating] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const [aiQuestion, setAiQuestion] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const config = useConfigStore((state) => state.config);
  const setLeftPanelType = useViewStore((state) => state.setLeftPanelType);
  const setSourceText = useTranslateStore((state) => state.setSourceText);
  const sendMessage = useEventChatStore((state) => state.sendMessage);
  const currentWorkspace = useWorkspaceStore((state) => state.getCurrentWorkspace());

  // 右键菜单显示
  const handleContextMenu = useCallback((e: MouseEvent) => {
    const selectedText = window.getSelection()?.toString().trim();
    if (selectedText && selectedText.length > 0 && selectedText.length < 5000) {
      e.preventDefault();
      setSelection({
        text: selectedText,
        position: { x: e.clientX, y: e.clientY },
      });
      setCopied(false);
      setMode('menu');
      setTranslatedText('');
      setTranslateError(null);
      setAiQuestion('');
    }
  }, []);

  // 点击外部关闭
  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
      setSelection(null);
    }
  }, []);

  // ESC 关闭
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (mode !== 'menu') {
        setMode('menu');
      } else {
        setSelection(null);
      }
    }
  }, [mode]);

  useEffect(() => {
    document.addEventListener('contextmenu', handleContextMenu);
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('contextmenu', handleContextMenu);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleContextMenu, handleClickOutside, handleKeyDown]);

  // 聚焦输入框
  useEffect(() => {
    if (mode === 'askAIModal' && inputRef.current) {
      inputRef.current.focus();
    }
  }, [mode]);

  // 调整菜单位置
  const adjustPosition = useCallback((pos: Position) => {
    const menuWidth = 280;
    const menuHeight = mode === 'menu' ? 200 : mode === 'translateResult' ? 180 : 200;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let x = pos.x;
    let y = pos.y;

    if (x + menuWidth > viewportWidth) {
      x = viewportWidth - menuWidth - 8;
    }
    if (y + menuHeight > viewportHeight) {
      y = viewportHeight - menuHeight - 8;
    }

    return { x: Math.max(8, x), y: Math.max(8, y) };
  }, [mode]);

  // 复制
  const handleCopy = async () => {
    if (!selection) return;
    await navigator.clipboard.writeText(selection.text);
    setCopied(true);
    setTimeout(() => {
      setSelection(null);
    }, 500);
  };

  // 搜索（使用外部浏览器）
  const handleSearch = async () => {
    if (!selection) return;
    const query = encodeURIComponent(selection.text);
    const searchUrl = `https://www.bing.com/search?q=${query}`;
    await openUrl(searchUrl);
    setSelection(null);
  };

  // 翻译
  const handleTranslate = async () => {
    if (!selection) return;

    const baiduConfig = config?.baiduTranslate;
    if (!baiduConfig?.appId || !baiduConfig?.secretKey) {
      // 未配置则跳转到翻译面板
      setSourceText(selection.text);
      setLeftPanelType('translate');
      setSelection(null);
      return;
    }

    const isChinese = containsChinese(selection.text);
    const to = isChinese ? 'en' : 'zh';

    setIsTranslating(true);
    setTranslateError(null);

    try {
      const result = await baiduTranslate(
        selection.text,
        baiduConfig.appId,
        baiduConfig.secretKey,
        to
      );

      if (result.success && result.result) {
        setTranslatedText(result.result);
        setMode('translateResult');
      } else {
        setTranslateError(result.error || t('errors.failed'));
      }
    } catch (e) {
      setTranslateError(e instanceof Error ? e.message : t('errors.requestFailed'));
    } finally {
      setIsTranslating(false);
    }
  };

  // 复制翻译结果
  const handleCopyTranslation = async () => {
    if (translatedText) {
      await navigator.clipboard.writeText(translatedText);
      setSelection(null);
    }
  };

  // 复制引用
  const handleCopyQuote = async () => {
    if (!selection) return;
    const quotedText = `> ${selection.text}`;
    await navigator.clipboard.writeText(quotedText);
    setSelection(null);
  };

  // 打开问 AI 弹窗
  const handleOpenAskAIModal = () => {
    setMode('askAIModal');
  };

  // 发送引用问 AI
  const handleSendAskAI = async () => {
    if (!selection || !currentWorkspace) return;

    const question = aiQuestion.trim() || '请解释这段内容';
    const message = `> ${selection.text}\n\n${question}`;

    await sendMessage(message, currentWorkspace.path);
    setSelection(null);
  };

  if (!selection) return null;

  const adjustedPos = adjustPosition(selection.position);

  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    left: adjustedPos.x,
    top: adjustedPos.y,
    zIndex: 9999,
  };

  // 翻译结果视图
  if (mode === 'translateResult') {
    return (
      <div
        ref={menuRef}
        style={menuStyle}
        className="bg-background-surface border border-border rounded-lg shadow-lg overflow-hidden min-w-[280px] max-w-[360px]"
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-background-elevated">
          <div className="flex items-center gap-2">
            <Languages size={14} className="text-primary" />
            <span className="text-xs font-medium text-text-primary">{t('translateResult')}</span>
          </div>
          <button
            onClick={() => setMode('menu')}
            className="p-1 text-text-tertiary hover:text-text-primary rounded transition-colors"
          >
            <X size={12} />
          </button>
        </div>

        <div className="p-3">
          <div className="text-xs text-text-tertiary mb-1">{t('sourceText')}:</div>
          <div className="text-sm text-text-primary bg-background-surface p-2 rounded border border-border mb-3 max-h-[80px] overflow-y-auto">
            {selection.text.length > 150 ? selection.text.slice(0, 150) + '...' : selection.text}
          </div>

          <div className="text-xs text-text-tertiary mb-1">{t('translatedText')}:</div>
          <div className="text-sm text-text-primary bg-primary/5 border border-primary/20 p-2 rounded max-h-[100px] overflow-y-auto">
            {translatedText}
          </div>

          <button
            onClick={handleCopyTranslation}
            className="w-full mt-3 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/80 transition-colors flex items-center justify-center gap-2"
          >
            <Copy size={14} />
            {tCommon('buttons.copy')}
          </button>
        </div>
      </div>
    );
  }

  // 问 AI 弹窗
  if (mode === 'askAIModal') {
    return (
      <div
        ref={menuRef}
        style={menuStyle}
        className="bg-background-surface border border-border rounded-lg shadow-lg overflow-hidden min-w-[280px] max-w-[360px]"
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-background-elevated">
          <div className="flex items-center gap-2">
            <MessageSquare size={14} className="text-primary" />
            <span className="text-xs font-medium text-text-primary">{t('askAI')}</span>
          </div>
          <button
            onClick={() => setMode('menu')}
            className="p-1 text-text-tertiary hover:text-text-primary rounded transition-colors"
          >
            <X size={12} />
          </button>
        </div>

        <div className="p-3">
          <div className="text-xs text-text-tertiary mb-1">{t('referenceContent') || '引用内容'}:</div>
          <div className="text-sm text-text-primary bg-background-surface p-2 rounded border border-border mb-3 max-h-[80px] overflow-y-auto">
            {selection.text.length > 150 ? selection.text.slice(0, 150) + '...' : selection.text}
          </div>

          <div className="text-xs text-text-tertiary mb-1">{t('yourQuestion') || '你的问题'}:</div>
          <input
            ref={inputRef}
            type="text"
            value={aiQuestion}
            onChange={(e) => setAiQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSendAskAI();
              }
            }}
            placeholder={t('questionPlaceholder') || '请输入问题...'}
            className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg focus:outline-none focus:border-primary text-text-primary placeholder:text-text-tertiary"
          />

          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={() => setMode('menu')}
              className="flex-1 py-2 text-sm text-text-secondary bg-background-surface border border-border rounded-lg hover:bg-background-hover transition-colors"
            >
              {tCommon('buttons.cancel')}
            </button>
            <button
              onClick={handleSendAskAI}
              className="flex-1 py-2 text-sm text-white bg-primary rounded-lg hover:bg-primary/80 transition-colors flex items-center justify-center gap-1"
            >
              <Send size={14} />
              {tCommon('buttons.confirm')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 主菜单
  const menuItems = [
    {
      id: 'copy',
      icon: copied ? <Check size={14} className="text-success" /> : <Copy size={14} />,
      label: copied ? tCommon('buttons.copied') : tCommon('buttons.copy'),
      onClick: handleCopy,
    },
    {
      id: 'search',
      icon: <Search size={14} />,
      label: t('search') || '搜索',
      onClick: handleSearch,
    },
    {
      id: 'translate',
      icon: isTranslating ? <Loader2 size={14} className="animate-spin" /> : <Languages size={14} />,
      label: containsChinese(selection.text) ? t('translateToEn') : t('translateToZh'),
      onClick: handleTranslate,
      disabled: isTranslating,
    },
    {
      id: 'copyQuote',
      icon: <Quote size={14} />,
      label: t('copyQuote') || '复制引用',
      onClick: handleCopyQuote,
    },
    {
      id: 'askAI',
      icon: <MessageSquare size={14} />,
      label: t('askAI') || '引用问 AI',
      onClick: handleOpenAskAIModal,
    },
  ];

  return (
    <div
      ref={menuRef}
      style={menuStyle}
      className="bg-background-surface border border-border rounded-lg shadow-lg py-1 min-w-[140px]"
    >
      {menuItems.map((item) => (
        <button
          key={item.id}
          type="button"
          disabled={item.disabled}
          className="w-full px-3 py-2 text-left text-sm text-text-secondary hover:bg-background-hover hover:text-text-primary flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={item.onClick}
        >
          <span className="text-text-tertiary">{item.icon}</span>
          <span>{item.label}</span>
        </button>
      ))}

      {translateError && (
        <div className="px-3 py-2 text-xs text-danger border-t border-border">
          {translateError}
        </div>
      )}
    </div>
  );
}
