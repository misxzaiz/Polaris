/**
 * 设置侧边栏导航
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  IconAIEngine,
  IconSearch,
  IconGeneral,
  IconMic,
  IconMessageSquareText,
} from '../Common/Icons';
import { BarChart3, Download, Code2, Globe, Blocks, Server, Palette } from 'lucide-react';
import { isTauri } from '@/utils/platform';
import type { ReactNode } from 'react';

export type SettingsTabId =
  | 'general'
  | 'theme'
  | 'prompt-snippet'
  | 'ai-engine'
  | 'model-provider'
  | 'speech'
  | 'lsp'
  | 'app-update'
  | 'plugins'
  | 'advanced'
  | 'web'
  | 'token-stats'
  | 'performance';

export interface SettingsNavItem {
  id: SettingsTabId;
  icon: ReactNode;
  labelKey: string;
}

interface SettingsSidebarProps {
  /**
   * 是否宽布局（横排导航在左）。由 SettingsPage 按容器实测宽计算后传入，
   * 不再用 CSS 媒体查询自判——WebView2 分数缩放下媒体查询会陈旧/部分失效
   * （见 plans/settings-layout-width-driven.md）。
   */
  wide: boolean;
  activeTab: SettingsTabId;
  onTabChange: (tab: SettingsTabId) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
}

const NAV_ITEMS: SettingsNavItem[] = [
  { id: 'general', icon: <IconGeneral size={16} />, labelKey: 'nav.general' },
  { id: 'theme', icon: <Palette size={16} />, labelKey: 'nav.theme' },
  { id: 'prompt-snippet', icon: <IconMessageSquareText size={16} />, labelKey: 'nav.promptSnippet' },
  { id: 'ai-engine', icon: <IconAIEngine size={16} />, labelKey: 'nav.aiEngine' },
  { id: 'model-provider', icon: <Server size={16} />, labelKey: 'nav.modelProvider' },
  { id: 'token-stats', icon: <BarChart3 size={16} />, labelKey: 'nav.tokenStats' },

  { id: 'speech', icon: <IconMic size={16} />, labelKey: 'nav.speech' },
  { id: 'lsp', icon: <Code2 size={16} />, labelKey: 'nav.lsp' },
  { id: 'plugins', icon: <Blocks size={16} />, labelKey: 'nav.plugins' },
  { id: 'app-update', icon: <Download size={16} />, labelKey: 'nav.appUpdate' },
  { id: 'web', icon: <Globe size={16} />, labelKey: 'nav.web' },
  // { id: 'advanced', icon: <IconSettings size={16} />, labelKey: 'nav.advanced' },
];

/** 桌面端专属 Tab ID */
const DESKTOP_ONLY_TABS: SettingsTabId[] = ['app-update', 'web'];

export function SettingsSidebar({ wide, activeTab, onTabChange, searchQuery, onSearchChange }: SettingsSidebarProps) {
  const { t } = useTranslation('settings');
  const isDesktop = isTauri();
  const navItems = useMemo(
    () => isDesktop ? NAV_ITEMS : NAV_ITEMS.filter(item => !DESKTOP_ONLY_TABS.includes(item.id)),
    [isDesktop],
  );

  return (
    <div
      data-theme-panel
      className={
        wide
          ? 'w-56 flex-shrink-0 border-r border-border-subtle bg-background-elevated flex flex-col'
          : 'border-b border-border-subtle bg-background-elevated flex'
      }
    >
      {/* 搜索框 — 窄布局隐藏，宽布局显示 */}
      <div className={`${wide ? 'block' : 'hidden'} p-3 border-b border-border-subtle`}>
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

      {/* 导航列表 — 窄布局水平滚动横条，宽布局垂直列表 */}
      <nav className={`flex ${wide ? 'flex-col flex-1 overflow-y-auto py-2' : 'overflow-x-auto py-0'}`}>
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onTabChange(item.id)}
            className={`flex-shrink-0 ${wide ? 'w-full' : ''} flex items-center gap-2 px-4 py-2.5 text-left text-sm transition-colors ${
              activeTab === item.id
                ? wide
                  ? 'bg-primary/10 text-primary border-r-2 border-primary'
                  : 'bg-primary/10 text-primary border-b-2 border-primary'
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
