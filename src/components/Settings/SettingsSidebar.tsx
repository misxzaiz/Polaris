/**
 * 设置侧边栏导航
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  IconAIEngine,
  IconBot,
  IconSearch,
  IconGeneral,
  IconMic,
  IconMessageSquareText,
} from '../Common/Icons';
import { Download, Shield, Code2, Globe, Blocks, Server, BookOpen, Keyboard, Palette } from 'lucide-react';
import { isTauri } from '@/utils/platform';
import type { ReactNode } from 'react';

export type SettingsTabId =
  | 'general'
  | 'theme-custom'
  | 'system-prompt'
  | 'prompt-snippet'
  | 'ai-engine'
  | 'model-provider'
  | 'qqbot'
  | 'feishu'
  | 'speech'
  | 'lsp'
  | 'shortcuts'
  | 'auto-mode'
  | 'app-update'
  | 'plugins'
  | 'advanced'
  | 'web'
  | 'personal-hub';

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
  { id: 'theme-custom', icon: <Palette size={16} />, labelKey: 'nav.themeCustom' },
  { id: 'system-prompt', icon: <IconMessageSquareText size={16} />, labelKey: 'nav.systemPrompt' },
  { id: 'prompt-snippet', icon: <IconMessageSquareText size={16} />, labelKey: 'nav.promptSnippet' },
  { id: 'ai-engine', icon: <IconAIEngine size={16} />, labelKey: 'nav.aiEngine' },
  { id: 'model-provider', icon: <Server size={16} />, labelKey: 'nav.modelProvider' },
  { id: 'qqbot', icon: <IconBot size={16} />, labelKey: 'nav.qqbot' },
  { id: 'feishu', icon: <IconBot size={16} />, labelKey: 'nav.feishu' },
  { id: 'speech', icon: <IconMic size={16} />, labelKey: 'nav.speech' },
  { id: 'lsp', icon: <Code2 size={16} />, labelKey: 'nav.lsp' },
  { id: 'shortcuts', icon: <Keyboard size={16} />, labelKey: 'nav.shortcuts' },
  { id: 'auto-mode', icon: <Shield size={16} />, labelKey: 'nav.autoMode' },
  { id: 'plugins', icon: <Blocks size={16} />, labelKey: 'nav.plugins' },
  { id: 'app-update', icon: <Download size={16} />, labelKey: 'nav.appUpdate' },
  { id: 'web', icon: <Globe size={16} />, labelKey: 'nav.web' },
  { id: 'personal-hub', icon: <BookOpen size={16} />, labelKey: 'nav.personalHub' },
  // { id: 'advanced', icon: <IconSettings size={16} />, labelKey: 'nav.advanced' },
];

/** 桌面端专属 Tab ID */
const DESKTOP_ONLY_TABS: SettingsTabId[] = ['app-update', 'web'];

export function SettingsSidebar({ activeTab, onTabChange, searchQuery, onSearchChange }: SettingsSidebarProps) {
  const { t } = useTranslation('settings');
  const isDesktop = isTauri();
  const navItems = useMemo(
    () => isDesktop ? NAV_ITEMS : NAV_ITEMS.filter(item => !DESKTOP_ONLY_TABS.includes(item.id)),
    [isDesktop],
  );

  return (
    <div className="sm:w-56 sm:flex-shrink-0 sm:border-r sm:border-b-0 border-b border-border-subtle bg-background-elevated flex sm:flex-col">
      {/* 搜索框 — 小屏隐藏，大屏显示 */}
      <div className="hidden sm:block p-3 border-b border-border-subtle">
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

      {/* 导航列表 — 小屏水平滚动，大屏垂直列表 */}
      <nav className="flex sm:flex-col overflow-x-auto sm:overflow-y-auto sm:flex-1 py-0 sm:py-2">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onTabChange(item.id)}
            className={`flex-shrink-0 flex items-center gap-2 px-4 py-2.5 text-left text-sm transition-colors sm:w-full ${
              activeTab === item.id
                ? 'bg-primary/10 text-primary border-b-2 sm:border-b-0 sm:border-r-2 border-primary'
                : 'text-text-secondary hover:bg-surface hover:text-text-primary'
            }`}
          >
            <span className="flex-shrink-0">{item.icon}</span>
            <span className="whitespace-nowrap">{t(item.labelKey)}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
