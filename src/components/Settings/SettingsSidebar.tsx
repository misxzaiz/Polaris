/**
 * 设置侧边栏导航
 */

import { useTranslation } from 'react-i18next';
import {
  IconAIEngine,
  IconTranslate,
  IconBot,
  IconSettings,
  IconSearch,
  IconGeneral,
  IconMic,
  IconMessageSquareText,
} from '../Common/Icons';
import type { ReactNode } from 'react';

export type SettingsTabId =
  | 'general'
  | 'system-prompt'
  | 'prompt-snippet'
  | 'ai-engine'
  | 'translate'
  | 'qqbot'
  | 'feishu'
  | 'speech'
  | 'window'
  | 'advanced';

export interface SettingsNavItem {
  id: SettingsTabId;
  icon: ReactNode;
  labelKey: string;
}

interface SettingsSidebarProps {
  activeTab: SettingsTabId;
  onTabChange: (tab: SettingsTabId) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
}

const NAV_ITEMS: SettingsNavItem[] = [
  { id: 'general', icon: <IconGeneral size={16} />, labelKey: 'nav.general' },
  { id: 'system-prompt', icon: <IconMessageSquareText size={16} />, labelKey: 'nav.systemPrompt' },
  { id: 'prompt-snippet', icon: <IconMessageSquareText size={16} />, labelKey: 'nav.promptSnippet' },
  { id: 'window', icon: <IconSettings size={16} />, labelKey: 'nav.window' },
  { id: 'ai-engine', icon: <IconAIEngine size={16} />, labelKey: 'nav.aiEngine' },
  { id: 'translate', icon: <IconTranslate size={16} />, labelKey: 'nav.translate' },
  { id: 'qqbot', icon: <IconBot size={16} />, labelKey: 'nav.qqbot' },
  { id: 'feishu', icon: <IconBot size={16} />, labelKey: 'nav.feishu' },
  { id: 'speech', icon: <IconMic size={16} />, labelKey: 'nav.speech' },
  // { id: 'advanced', icon: <IconSettings size={16} />, labelKey: 'nav.advanced' },
];

export function SettingsSidebar({ activeTab, onTabChange, searchQuery, onSearchChange }: SettingsSidebarProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="w-48 flex-shrink-0 border-r border-border-subtle bg-background-elevated flex flex-col">
      {/* 搜索框 */}
      <div className="p-3 border-b border-border-subtle">
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t('search')}
            className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-1.5 pr-8 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-primary"
          />
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted">
            <IconSearch size={14} />
          </span>
        </div>
      </div>

      {/* 导航列表 */}
      <nav className="flex-1 overflow-y-auto py-2">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => onTabChange(item.id)}
            className={`w-full flex items-center gap-2 px-4 py-2.5 text-left text-sm transition-colors ${
              activeTab === item.id
                ? 'bg-primary/10 text-primary border-r-2 border-primary'
                : 'text-text-secondary hover:bg-surface hover:text-text-primary'
            }`}
          >
            <span className="flex-shrink-0">{item.icon}</span>
            <span>{t(item.labelKey)}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
