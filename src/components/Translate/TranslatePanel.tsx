import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTranslateStore, useConfigStore } from '../../stores';
import { ArrowRightLeft, Copy, Send, Trash2, Clock } from 'lucide-react';

interface TranslatePanelProps {
  onSendToChat?: (text: string) => void;
}

export function TranslatePanel({ onSendToChat }: TranslatePanelProps) {
  const { t } = useTranslation('translate');
  const { t: tCommon } = useTranslation('common');

  const {
    sourceText,
    translatedText,
    direction,
    isTranslating,
    error,
    history,
    setSourceText,
    setDirection,
    translate,
    clearResult,
    removeFromHistory,
    clearHistory,
  } = useTranslateStore();

  // 获取百度翻译配置用于参数注入
  const baiduConfig = useConfigStore((state) => state.config?.baiduTranslate);

  const [showHistory, setShowHistory] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (translatedText) {
      await navigator.clipboard.writeText(translatedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleSendToChat = () => {
    if (translatedText && onSendToChat) {
      onSendToChat(translatedText);
    }
  };

  const handleHistoryClick = (item: { sourceText: string; translatedText: string }) => {
    setSourceText(item.sourceText);
    useTranslateStore.getState().setTranslatedText(item.translatedText);
    setShowHistory(false);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <ArrowRightLeft size={16} className="text-primary" />
          <span className="text-sm font-medium text-text-primary">{t('title')}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowHistory(!showHistory)}
            className={`p-1.5 rounded transition-colors ${
              showHistory ? 'bg-primary/10 text-primary' : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'
            }`}
            title={t('history')}
          >
            <Clock size={14} />
          </button>
          <button
            onClick={clearResult}
            className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors"
            title={tCommon('buttons.clear')}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {showHistory ? (
        <div className="flex-1 overflow-y-auto p-3">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-text-secondary">{t('history')}</span>
            {history.length > 0 && (
              <button
                onClick={clearHistory}
                className="text-xs text-text-tertiary hover:text-danger transition-colors"
              >
                {tCommon('buttons.clearAll')}
              </button>
            )}
          </div>
          {history.length === 0 ? (
            <div className="text-center text-text-tertiary text-sm py-8">
              {t('noHistory')}
            </div>
          ) : (
            <div className="space-y-2">
              {history.map((item) => (
                <div
                  key={item.id}
                  className="p-3 bg-background-surface rounded-lg border border-border hover:border-primary/30 cursor-pointer transition-colors group"
                  onClick={() => handleHistoryClick(item)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-text-tertiary mb-1">
                        {item.direction === 'toEn' ? t('toEn') : t('toZh')}
                      </div>
                      <div className="text-sm text-text-primary truncate">{item.sourceText}</div>
                      <div className="text-sm text-text-secondary truncate mt-1">{item.translatedText}</div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeFromHistory(item.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 p-1 text-text-tertiary hover:text-danger transition-all"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex flex-col overflow-hidden p-3 gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setDirection('toEn')}
                className={`px-3 py-1.5 text-xs rounded-full transition-colors ${
                  direction === 'toEn'
                    ? 'bg-primary text-white'
                    : 'bg-background-surface text-text-secondary hover:text-text-primary'
                }`}
              >
                {t('toEn')}
              </button>
              <button
                onClick={() => setDirection('toZh')}
                className={`px-3 py-1.5 text-xs rounded-full transition-colors ${
                  direction === 'toZh'
                    ? 'bg-primary text-white'
                    : 'bg-background-surface text-text-secondary hover:text-text-primary'
                }`}
              >
                {t('toZh')}
              </button>
            </div>
            <button
              onClick={() => translate(baiduConfig)}
              disabled={isTranslating || !sourceText.trim()}
              className="px-4 py-1.5 text-xs bg-primary text-white rounded-full hover:bg-primary/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isTranslating ? tCommon('status.translating') : t('translate')}
            </button>
          </div>

          <div className="flex-1 flex flex-col min-h-0">
            <div className="text-xs text-text-tertiary mb-1">{t('sourceText')}</div>
            <textarea
              value={sourceText}
              onChange={(e) => setSourceText(e.target.value)}
              placeholder={direction === 'toEn' ? t('inputChinese') : t('inputEnglish')}
              className="flex-1 min-h-[80px] p-3 bg-background-surface border border-border rounded-lg text-sm text-text-primary placeholder:text-text-tertiary resize-none outline-none focus:border-primary transition-colors"
            />
          </div>

          {error && (
            <div className="p-3 bg-danger/10 border border-danger/30 rounded-lg text-sm text-danger">
              {error}
            </div>
          )}

          {translatedText && (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="text-xs text-text-tertiary mb-1">{t('translatedText')}</div>
              <div className="flex-1 min-h-[80px] p-3 bg-primary/5 border border-primary/20 rounded-lg text-sm text-text-primary overflow-y-auto">
                {translatedText}
              </div>
              <div className="flex items-center gap-2 mt-2">
                <button
                  onClick={handleCopy}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary bg-background-surface border border-border rounded-lg transition-colors"
                >
                  <Copy size={12} />
                  {copied ? tCommon('buttons.copied') : tCommon('buttons.copy')}
                </button>
                {onSendToChat && (
                  <button
                    onClick={handleSendToChat}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs text-white bg-primary rounded-lg hover:bg-primary/80 transition-colors"
                  >
                    <Send size={12} />
                    {t('sendToChat')}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
