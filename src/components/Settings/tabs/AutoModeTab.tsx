/**
 * Auto-Mode 配置 Tab
 *
 * 支持双模式：规则列表模式 + 高级 JSON 编辑模式
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Shield,
  AlertTriangle,
  CheckCircle,
  Search,
  Info,
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
  Code,
  List,
} from 'lucide-react';
import { useAutoModeStore } from '../../../stores/autoModeStore';
import { Button } from '../../Common';
import type { RuleType } from '../../../types/autoMode';

export function AutoModeTab() {
  const { t } = useTranslation('settings');
  const {
    config,
    defaults,
    customRules,
    settings,
    settingsPath,
    loading,
    saving,
    error,
    searchQuery,
    editMode,
    fetchConfig,
    fetchDefaults,
    fetchSettings,
    addCustomRule,
    removeCustomRule,
    updateSettings,
    setSearchQuery,
    setEditMode,
    clearError,
  } = useAutoModeStore();

  const [activeSection, setActiveSection] = useState<RuleType>('allow');
  const [showDefaultRules, setShowDefaultRules] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newRuleName, setNewRuleName] = useState('');
  const [newRuleDesc, setNewRuleDesc] = useState('');
  const [jsonEditValue, setJsonEditValue] = useState('');

  // 初始化加载
  useEffect(() => {
    fetchConfig();
    fetchDefaults();
    fetchSettings();
  }, [fetchConfig, fetchDefaults, fetchSettings]);

  // 当切换到高级编辑模式时，初始化 JSON 编辑器内容
  useEffect(() => {
    if (editMode === 'advanced' && settings) {
      setJsonEditValue(JSON.stringify(settings, null, 2));
    }
  }, [editMode, settings]);

  // 过滤默认规则
  const filteredDefaultAllowRules = useMemo(() => {
    if (!defaults?.allow) return [];
    if (!searchQuery) return defaults.allow;
    return defaults.allow.filter((rule) =>
      rule.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [defaults?.allow, searchQuery]);

  const filteredDefaultDenyRules = useMemo(() => {
    if (!defaults?.soft_deny) return [];
    if (!searchQuery) return defaults.soft_deny;
    return defaults.soft_deny.filter((rule) =>
      rule.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [defaults?.soft_deny, searchQuery]);

  // 添加规则
  const handleAddRule = useCallback(async () => {
    if (!newRuleName.trim()) return;
    const rule = newRuleDesc.trim()
      ? `${newRuleName.trim()}: ${newRuleDesc.trim()}`
      : newRuleName.trim();
    await addCustomRule(activeSection, rule);
    setShowAddDialog(false);
    setNewRuleName('');
    setNewRuleDesc('');
  }, [newRuleName, newRuleDesc, activeSection, addCustomRule]);

  // 删除规则
  const handleRemoveRule = useCallback(
    async (type: RuleType, index: number) => {
      if (window.confirm(t('autoMode.confirmDelete'))) {
        await removeCustomRule(type, index);
      }
    },
    [removeCustomRule, t]
  );

  // 保存 JSON 编辑
  const handleSaveJson = useCallback(async () => {
    try {
      const parsed = JSON.parse(jsonEditValue);
      await updateSettings(parsed);
    } catch {
      // JSON 解析错误已在 store 中处理
    }
  }, [jsonEditValue, updateSettings]);

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
      {/* Tab 切换 */}
      <div className="flex items-center gap-2 border-b border-border-subtle pb-3">
        <button
          onClick={() => setEditMode('list')}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors ${
            editMode === 'list'
              ? 'bg-primary/10 text-primary'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          <List className="w-4 h-4" />
          {t('autoMode.tabRulesList')}
        </button>
        <button
          onClick={() => setEditMode('advanced')}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors ${
            editMode === 'advanced'
              ? 'bg-primary/10 text-primary'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          <Code className="w-4 h-4" />
          {t('autoMode.tabAdvancedEdit')}
        </button>
      </div>

      {editMode === 'list' ? (
        <>
          {/* 说明区域 */}
          <div className="p-4 bg-surface rounded-lg border border-border">
            <div className="flex items-start gap-3">
              <Info className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
              <div className="text-sm text-text-secondary">
                <p className="font-medium text-text-primary mb-1">
                  {t('autoMode.description')}
                </p>
                <p>{t('autoMode.descriptionDetail')}</p>
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
              placeholder={t('autoMode.searchPlaceholder')}
              className="w-full pl-10 pr-4 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:border-primary"
            />
          </div>

          {/* 我的规则 */}
          <div className="border border-border rounded-lg overflow-hidden">
            <div className="bg-surface px-4 py-3 border-b border-border">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-text-primary flex items-center gap-2">
                  <Shield className="w-4 h-4" />
                  {t('autoMode.myRules')}
                </h3>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setActiveSection('allow');
                      setShowAddDialog(true);
                    }}
                    className="flex items-center gap-1 px-2 py-1 text-xs bg-green-500/10 text-green-600 rounded hover:bg-green-500/20 transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                    {t('autoMode.addAllowRule')}
                  </button>
                  <button
                    onClick={() => {
                      setActiveSection('softDeny');
                      setShowAddDialog(true);
                    }}
                    className="flex items-center gap-1 px-2 py-1 text-xs bg-yellow-500/10 text-yellow-600 rounded hover:bg-yellow-500/20 transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                    {t('autoMode.addSoftDenyRule')}
                  </button>
                </div>
              </div>
            </div>

            <div className="p-4">
              {customRules.allow.length === 0 && customRules.softDeny.length === 0 ? (
                <p className="text-sm text-text-muted text-center py-4">
                  {t('autoMode.customRulesEmpty')}
                </p>
              ) : (
                <div className="space-y-4">
                  {/* 自定义允许规则 */}
                  {customRules.allow.length > 0 && (
                    <div>
                      <h4 className="text-xs text-text-secondary mb-2 flex items-center gap-1">
                        <CheckCircle className="w-3 h-3 text-green-500" />
                        {t('autoMode.allow')} ({customRules.allow.length})
                      </h4>
                      <ul className="space-y-1">
                        {customRules.allow.map((rule, index) => (
                          <CustomRuleItem
                            key={index}
                            rule={rule}
                            type="allow"
                            onDelete={() => handleRemoveRule('allow', index)}
                          />
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* 自定义需确认规则 */}
                  {customRules.softDeny.length > 0 && (
                    <div>
                      <h4 className="text-xs text-text-secondary mb-2 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3 text-yellow-500" />
                        {t('autoMode.softDeny')} ({customRules.softDeny.length})
                      </h4>
                      <ul className="space-y-1">
                        {customRules.softDeny.map((rule, index) => (
                          <CustomRuleItem
                            key={index}
                            rule={rule}
                            type="softDeny"
                            onDelete={() => handleRemoveRule('softDeny', index)}
                          />
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* 默认规则 */}
          <div className="border border-border rounded-lg overflow-hidden">
            <button
              onClick={() => setShowDefaultRules(!showDefaultRules)}
              className="w-full bg-surface px-4 py-3 flex items-center justify-between hover:bg-surface/80 transition-colors"
            >
              <div className="flex items-center gap-3">
                <Info className="w-4 h-4 text-text-muted" />
                <div className="text-left">
                  <h3 className="text-sm font-medium text-text-primary">
                    {t('autoMode.defaultRules')}
                  </h3>
                  <p className="text-xs text-text-muted">{t('autoMode.defaultRulesHint')}</p>
                </div>
              </div>
              <div className="flex items-center gap-3 text-text-muted">
                <span className="text-xs">
                  {t('autoMode.defaultRulesInfo', {
                    allow: filteredDefaultAllowRules.length,
                    deny: filteredDefaultDenyRules.length,
                  })}
                </span>
                {showDefaultRules ? (
                  <ChevronUp className="w-4 h-4" />
                ) : (
                  <ChevronDown className="w-4 h-4" />
                )}
              </div>
            </button>

            {showDefaultRules && (
              <div className="p-4 border-t border-border">
                {/* 默认规则统计 */}
                <div className="flex items-center gap-4 mb-4">
                  <button
                    onClick={() => setActiveSection('allow')}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                      activeSection === 'allow'
                        ? 'bg-green-500/10 text-green-600 border border-green-500/30'
                        : 'bg-surface border border-border text-text-secondary'
                    }`}
                  >
                    <CheckCircle className="w-4 h-4" />
                    {t('autoMode.allow')} ({filteredDefaultAllowRules.length})
                  </button>
                  <button
                    onClick={() => setActiveSection('softDeny')}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                      activeSection === 'softDeny'
                        ? 'bg-yellow-500/10 text-yellow-600 border border-yellow-500/30'
                        : 'bg-surface border border-border text-text-secondary'
                    }`}
                  >
                    <AlertTriangle className="w-4 h-4" />
                    {t('autoMode.softDeny')} ({filteredDefaultDenyRules.length})
                  </button>
                </div>

                {/* 规则列表 */}
                <div className="max-h-96 overflow-y-auto">
                  {activeSection === 'allow' ? (
                    <RuleList
                      rules={filteredDefaultAllowRules}
                      type="allow"
                      searchQuery={searchQuery}
                    />
                  ) : (
                    <RuleList
                      rules={filteredDefaultDenyRules}
                      type="softDeny"
                      searchQuery={searchQuery}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        /* 高级编辑模式 */
        <div className="space-y-4">
          <div className="p-4 bg-surface rounded-lg border border-border">
            <p className="text-sm text-text-secondary mb-2">{t('autoMode.editJson')}</p>
            {settingsPath && (
              <p className="text-xs text-text-muted mb-4">
                {t('autoMode.settingsPath')}: <code className="text-primary">{settingsPath}</code>
              </p>
            )}
            <textarea
              value={jsonEditValue}
              onChange={(e) => setJsonEditValue(e.target.value)}
              className="w-full h-96 p-3 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:border-primary resize-none"
              spellCheck={false}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={handleSaveJson} disabled={saving}>
              {saving ? t('autoMode.saving') : t('autoMode.save')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                if (settings) {
                  setJsonEditValue(JSON.stringify(settings, null, 2));
                }
              }}
            >
              {t('autoMode.reset')}
            </Button>
          </div>
        </div>
      )}

      {/* 添加规则对话框 */}
      {showAddDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background-elevated rounded-xl p-6 w-96 max-w-[90vw] border border-border shadow-lg">
            <h3 className="text-sm font-medium text-text-primary mb-4">
              {activeSection === 'allow'
                ? t('autoMode.addAllowRule')
                : t('autoMode.addSoftDenyRule')}
            </h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-text-secondary mb-1">
                  {t('autoMode.ruleName')}
                </label>
                <input
                  type="text"
                  value={newRuleName}
                  onChange={(e) => setNewRuleName(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
                  placeholder="e.g., Local Operations"
                />
              </div>
              <div>
                <label className="block text-xs text-text-secondary mb-1">
                  {t('autoMode.ruleDescription')}
                </label>
                <textarea
                  value={newRuleDesc}
                  onChange={(e) => setNewRuleDesc(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary resize-none"
                  rows={3}
                  placeholder="e.g., Allow local file operations within project scope"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 mt-4">
              <Button variant="ghost" onClick={() => setShowAddDialog(false)}>
                {t('common.cancel', '取消')}
              </Button>
              <Button onClick={handleAddRule} disabled={!newRuleName.trim() || saving}>
                {saving ? t('autoMode.saving') : t('autoMode.save')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// 自定义规则项组件
function CustomRuleItem({
  rule,
  type,
  onDelete,
}: {
  rule: string;
  type: RuleType;
  onDelete: () => void;
}) {
  const colonIndex = rule.indexOf(':');
  const name = colonIndex > 0 ? rule.slice(0, colonIndex).trim() : rule;
  const description = colonIndex > 0 ? rule.slice(colonIndex + 1).trim() : '';

  const Icon = type === 'allow' ? CheckCircle : AlertTriangle;
  const iconColor = type === 'allow' ? 'text-green-500' : 'text-yellow-500';

  return (
    <li className="flex items-start gap-2 p-2 bg-background rounded group">
      <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${iconColor}`} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text-primary">{name}</div>
        {description && (
          <div className="text-xs text-text-secondary mt-0.5 line-clamp-2">{description}</div>
        )}
      </div>
      <button
        onClick={onDelete}
        className="opacity-0 group-hover:opacity-100 p-1 text-text-muted hover:text-danger transition-all"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </li>
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
      <div className="p-4 text-center text-text-muted text-sm">
        {searchQuery ? t('autoMode.noResults') : t('autoMode.noRules')}
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
    <li className="p-3 hover:bg-background-hover transition-colors">
      <div className="flex items-start gap-3">
        <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${iconColor}`} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-text-primary">{highlightText(name)}</div>
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
