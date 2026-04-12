/**
 * 片段变量填写浮窗
 *
 * 选中片段后，如果有用户变量需要填写，弹出此面板。
 * 填写完成后将模板展开到输入框。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PromptSnippet } from '../../types/promptSnippet';

interface SnippetParamPanelProps {
  snippet: PromptSnippet;
  onExpand: (expandedContent: string) => void;
  onCancel: () => void;
}

export function SnippetParamPanel({ snippet, onExpand, onCancel }: SnippetParamPanelProps) {
  const { t } = useTranslation('promptSnippet');

  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const v of snippet.variables) {
      init[v.key] = v.defaultValue ?? '';
    }
    return init;
  });

  const handleExpand = () => {
    let content = snippet.content;
    for (const [key, value] of Object.entries(values)) {
      content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
    }
    onExpand(content);
  };

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 px-3 z-10">
      <div className="bg-background-elevated border border-border rounded-xl shadow-lg p-3 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-text-primary">
            /{snippet.name} — {t('chat.fillParams')}
          </span>
          <button
            onClick={onCancel}
            className="text-text-tertiary hover:text-text-primary text-sm"
          >
            ✕
          </button>
        </div>

        {snippet.variables.map(v => (
          <div key={v.key} className="space-y-1">
            <label className="text-xs text-text-secondary">
              {v.label}
              {v.required && <span className="text-danger ml-1">*</span>}
            </label>
            {v.type === 'textarea' ? (
              <textarea
                value={values[v.key] ?? ''}
                onChange={e => setValues(prev => ({ ...prev, [v.key]: e.target.value }))}
                placeholder={v.placeholder}
                className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text-primary resize-none focus:outline-none focus:border-primary"
                rows={3}
              />
            ) : (
              <input
                type="text"
                value={values[v.key] ?? ''}
                onChange={e => setValues(prev => ({ ...prev, [v.key]: e.target.value }))}
                placeholder={v.placeholder}
                className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-primary"
              />
            )}
          </div>
        ))}

        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary"
          >
            {t('cancel')}
          </button>
          <button
            onClick={handleExpand}
            className="px-3 py-1.5 text-sm bg-primary text-white rounded-lg hover:bg-primary-hover"
          >
            {t('chat.expand')}
          </button>
        </div>
      </div>
    </div>
  );
}
