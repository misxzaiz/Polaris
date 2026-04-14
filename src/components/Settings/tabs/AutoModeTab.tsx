/**
 * Auto-Mode 配置 Tab
 *
 * 显示允许/拒绝规则，支持搜索和查看详情
 */

import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Shield, AlertTriangle, CheckCircle, Search, Info } from 'lucide-react';
import { useAutoModeStore } from '../../../stores/autoModeStore';
import { Button } from '../../Common';
import type { RuleType } from '../../../types/autoMode';

export function AutoModeTab() {
  const { t } = useTranslation('settings');
  const {
    config,
    loading,
    error,
    searchQuery,
    fetchConfig,
    setSearchQuery,
    clearError,
  } = useAutoModeStore();

  const [activeSection, setActiveSection] = useState<RuleType>('allow');

  // 初始化加载
  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // 过滤规则
  const filteredAllowRules = useMemo(() => {
    if (!config?.allow) return [];
    if (!searchQuery) return config.allow;
    return config.allow.filter(rule =>
      rule.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [config?.allow, searchQuery]);

  const filteredDenyRules = useMemo(() => {
    if (!config?.softDeny) return [];
    if (!searchQuery) return config.softDeny;
    return config.softDeny.filter(rule =>
      rule.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [config?.softDeny, searchQuery]);

  if (loading && !config) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-danger/10 border border-danger/30 rounded-lg">
        <p className="text-danger text-sm">{error}</p>
        <Button variant="ghost" onClick={clearError} className="mt-2">
          {t('common.dismiss', '关闭')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 说明区域 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <div className="flex items-start gap-3">
          <Info className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
          <div className="text-sm text-text-secondary">
            <p className="font-medium text-text-primary mb-1">
              {t('autoMode.description', '自动模式控制 Claude 在没有用户确认的情况下可以执行哪些操作')}
            </p>
            <p>
              {t('autoMode.descriptionDetail', '允许规则会自动执行，拒绝规则需要用户确认。这些规则用于保护您的系统和数据安全。')}
            </p>
          </div>
        </div>
      </div>

      {/* 搜索框 */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('autoMode.searchPlaceholder', '搜索规则...')}
          className="w-full pl-10 pr-4 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:border-primary"
        />
      </div>

      {/* 规则统计 */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => setActiveSection('allow')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors ${
            activeSection === 'allow'
              ? 'bg-green-500/10 text-green-600 border border-green-500/30'
              : 'bg-surface border border-border text-text-secondary hover:text-text-primary'
          }`}
        >
          <CheckCircle className="w-4 h-4" />
          {t('autoMode.allow', '允许')} ({filteredAllowRules.length})
        </button>
        <button
          onClick={() => setActiveSection('softDeny')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors ${
            activeSection === 'softDeny'
              ? 'bg-yellow-500/10 text-yellow-600 border border-yellow-500/30'
              : 'bg-surface border border-border text-text-secondary hover:text-text-primary'
          }`}
        >
          <AlertTriangle className="w-4 h-4" />
          {t('autoMode.softDeny', '需确认')} ({filteredDenyRules.length})
        </button>
      </div>

      {/* 规则列表 */}
      <div className="border border-border rounded-lg overflow-hidden">
        {activeSection === 'allow' ? (
          <RuleList
            rules={filteredAllowRules}
            type="allow"
            searchQuery={searchQuery}
          />
        ) : (
          <RuleList
            rules={filteredDenyRules}
            type="softDeny"
            searchQuery={searchQuery}
          />
        )}
      </div>

      {/* 环境配置 */}
      {config?.environment && config.environment.length > 0 && (
        <div className="p-4 bg-surface rounded-lg border border-border">
          <h4 className="text-sm font-medium text-text-primary mb-2 flex items-center gap-2">
            <Shield className="w-4 h-4" />
            {t('autoMode.environment', '环境配置')}
          </h4>
          <ul className="space-y-1">
            {config.environment.map((env, index) => (
              <li key={index} className="text-xs text-text-secondary pl-6">
                {env.replace(/\*\*(.*?)\*\*/g, '$1')}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// 规则列表组件
function RuleList({
  rules,
  type,
  searchQuery,
}: {
  rules: string[];
  type: RuleType;
  searchQuery: string;
}) {
  const { t } = useTranslation('settings');

  if (rules.length === 0) {
    return (
      <div className="p-8 text-center text-text-muted">
        {searchQuery
          ? t('autoMode.noResults', '没有找到匹配的规则')
          : t('autoMode.noRules', '暂无规则')}
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border-subtle">
      {rules.map((rule, index) => (
        <RuleItem key={index} rule={rule} type={type} searchQuery={searchQuery} />
      ))}
    </ul>
  );
}

// 规则项组件
function RuleItem({
  rule,
  type,
  searchQuery,
}: {
  rule: string;
  type: RuleType;
  searchQuery: string;
}) {
  // 解析规则名称和描述
  const colonIndex = rule.indexOf(':');
  const name = colonIndex > 0 ? rule.slice(0, colonIndex).trim() : rule;
  const description = colonIndex > 0 ? rule.slice(colonIndex + 1).trim() : '';

  // 高亮搜索词
  const highlightText = (text: string) => {
    if (!searchQuery) return text;
    const regex = new RegExp(`(${searchQuery})`, 'gi');
    return text.split(regex).map((part, i) =>
      regex.test(part) ? (
        <mark key={i} className="bg-yellow-200 text-yellow-900 rounded px-0.5">
          {part}
        </mark>
      ) : (
        part
      )
    );
  };

  const Icon = type === 'allow' ? CheckCircle : AlertTriangle;
  const iconColor = type === 'allow' ? 'text-green-500' : 'text-yellow-500';

  return (
    <li className="p-4 hover:bg-background-hover transition-colors">
      <div className="flex items-start gap-3">
        <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${iconColor}`} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-text-primary">
            {highlightText(name)}
          </div>
          {description && (
            <div className="mt-1 text-xs text-text-secondary leading-relaxed">
              {highlightText(description)}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
