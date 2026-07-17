/**
 * 派发任务设置区块（GeneralTab 内嵌）
 *
 * - 派发策略：auto（AI 派发直接执行）/ ask（每次弹确认）
 * - 结果注入开关：完成摘要是否注入来源会话下一回合
 * - 队员预设 CRUD：角色 → 引擎 + 模型 Profile + 模型 + 职责提示词
 *   保存时校验组合合法性（mimo 不支持 Profile）
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Bot } from 'lucide-react';
import type { Config, DispatchPreset } from '@/types/config';
import { generateUUID } from '@/utils/uuid';

interface DispatchSettingsSectionProps {
  config: Config;
  onConfigChange: (config: Config) => void;
  loading: boolean;
}

const ENGINE_OPTIONS = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'simple-ai', label: 'SimpleAI' },
  { id: 'mimo-code', label: 'Mimo' },
];

const PERMISSION_OPTIONS = ['', 'default', 'acceptEdits', 'bypassPermissions', 'plan'];

interface PresetDraft {
  name: string;
  engineId: string;
  modelProfileId: string;
  model: string;
  appendSystemPrompt: string;
  permissionMode: string;
}

const EMPTY_DRAFT: PresetDraft = {
  name: '',
  engineId: 'claude-code',
  modelProfileId: '',
  model: '',
  appendSystemPrompt: '',
  permissionMode: '',
};

export function DispatchSettingsSection({ config, onConfigChange, loading }: DispatchSettingsSectionProps) {
  const { t } = useTranslation('settings');
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<PresetDraft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);

  const dispatch = config.dispatch ?? {};
  const presets = dispatch.presets ?? [];
  const policy = dispatch.policy ?? 'auto';
  const autoInject = dispatch.autoInjectReports !== false;
  const profiles = config.modelProfiles ?? [];

  const patchDispatch = (patch: Partial<NonNullable<Config['dispatch']>>) => {
    onConfigChange({ ...config, dispatch: { ...dispatch, ...patch } });
  };

  const handleAddPreset = () => {
    const name = draft.name.trim();
    if (!name) {
      setFormError(t('dispatch.errors.nameRequired', '角色名不能为空'));
      return;
    }
    if (presets.some((p) => p.name === name)) {
      setFormError(t('dispatch.errors.nameDuplicated', '角色名已存在'));
      return;
    }
    // mimo 不支持模型 Profile（强制官方端点）
    if (draft.engineId.startsWith('mimo') && draft.modelProfileId) {
      setFormError(t('dispatch.errors.mimoNoProfile', 'Mimo 引擎不支持模型 Profile，请选择官方端点'));
      return;
    }

    const preset: DispatchPreset = {
      id: generateUUID(),
      name,
      engineId: draft.engineId,
      modelProfileId: draft.modelProfileId || undefined,
      model: draft.model.trim() || undefined,
      appendSystemPrompt: draft.appendSystemPrompt.trim() || undefined,
      permissionMode: draft.permissionMode || undefined,
    };
    patchDispatch({ presets: [...presets, preset] });
    setDraft(EMPTY_DRAFT);
    setFormError(null);
    setShowForm(false);
  };

  const handleDeletePreset = (id: string) => {
    patchDispatch({ presets: presets.filter((p) => p.id !== id) });
  };

  const profileName = (id?: string) =>
    id ? profiles.find((p) => p.id === id)?.name ?? id : t('dispatch.officialEndpoint', '官方端点');

  return (
    <div className="p-4 bg-surface rounded-lg border border-border">
      <h3 className="text-sm font-medium text-text-primary mb-3">
        {t('dispatch.title', '任务派发')}
      </h3>

      {/* 派发策略 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex-1 pr-4">
          <div className="text-sm text-text-primary">{t('dispatch.policy', '派发策略')}</div>
          <div className="text-xs text-text-secondary">
            {t('dispatch.policyHint', 'AI 通过 dispatch_task 派发后台任务时是否需要你确认。')}
          </div>
        </div>
        <select
          value={policy}
          disabled={loading}
          onChange={(e) => patchDispatch({ policy: e.target.value as 'auto' | 'ask' })}
          className="text-xs bg-background-surface border border-border rounded px-2 py-1.5 text-text-primary"
        >
          <option value="auto">{t('dispatch.policyAuto', '自动执行')}</option>
          <option value="ask">{t('dispatch.policyAsk', '每次询问')}</option>
        </select>
      </div>

      {/* 结果注入开关 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex-1 pr-4">
          <div className="text-sm text-text-primary">
            {t('dispatch.autoInject', '结果自动注入主会话')}
          </div>
          <div className="text-xs text-text-secondary">
            {t(
              'dispatch.autoInjectHint',
              '派发任务完成后，把结果摘要注入来源会话的下一回合，主 AI 无需你转述即可继续。'
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => patchDispatch({ autoInjectReports: !autoInject })}
          disabled={loading}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            autoInject ? 'bg-primary' : 'bg-border'
          } ${loading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          aria-pressed={autoInject}
          aria-label={t('dispatch.autoInject', '结果自动注入主会话')}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              autoInject ? 'translate-x-[18px]' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {/* 队员预设 */}
      <div className="border-t border-border pt-3">
        <div className="flex items-center justify-between mb-2">
          <div>
            <div className="text-sm text-text-primary">{t('dispatch.presets', '派发队员')}</div>
            <div className="text-xs text-text-secondary">
              {t(
                'dispatch.presetsHint',
                '预定义"角色 → 引擎/供应商/模型/职责"组合，AI 派发时用 role 参数引用（如 /dispatch @测试员）。'
              )}
            </div>
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              setShowForm(!showForm);
              setFormError(null);
            }}
            className="flex items-center gap-1 text-xs text-primary hover:text-primary-hover shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('dispatch.addPreset', '添加队员')}
          </button>
        </div>

        {/* 预设列表 */}
        {presets.length > 0 && (
          <div className="space-y-1.5 mb-2">
            {presets.map((preset) => (
              <div
                key={preset.id}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded bg-background-surface border border-border-subtle text-xs"
              >
                <Bot className="w-3.5 h-3.5 text-primary shrink-0" />
                <span className="font-medium text-text-primary shrink-0">{preset.name}</span>
                <span className="text-text-tertiary truncate">
                  {ENGINE_OPTIONS.find((e) => e.id === preset.engineId)?.label ?? preset.engineId}
                  {' · '}
                  {profileName(preset.modelProfileId)}
                  {preset.model ? ` · ${preset.model}` : ''}
                </span>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => handleDeletePreset(preset.id)}
                  className="ml-auto text-text-muted hover:text-error shrink-0"
                  aria-label={t('dispatch.deletePreset', '删除')}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 新增表单 */}
        {showForm && (
          <div className="space-y-2 p-3 rounded bg-background-surface border border-border-subtle">
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                value={draft.name}
                disabled={loading}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder={t('dispatch.presetName', '角色名，如"测试员"')}
                className="text-xs bg-background-base border border-border rounded px-2 py-1.5 text-text-primary placeholder:text-text-muted"
              />
              <select
                value={draft.engineId}
                disabled={loading}
                onChange={(e) => setDraft({ ...draft, engineId: e.target.value })}
                className="text-xs bg-background-base border border-border rounded px-2 py-1.5 text-text-primary"
              >
                {ENGINE_OPTIONS.map((engine) => (
                  <option key={engine.id} value={engine.id}>{engine.label}</option>
                ))}
              </select>
              <select
                value={draft.modelProfileId}
                disabled={loading}
                onChange={(e) => setDraft({ ...draft, modelProfileId: e.target.value })}
                className="text-xs bg-background-base border border-border rounded px-2 py-1.5 text-text-primary"
              >
                <option value="">{t('dispatch.officialEndpoint', '官方端点')}</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>{profile.name}</option>
                ))}
              </select>
              <input
                type="text"
                value={draft.model}
                disabled={loading}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                placeholder={t('dispatch.presetModel', '模型名（可选）')}
                className="text-xs bg-background-base border border-border rounded px-2 py-1.5 text-text-primary placeholder:text-text-muted"
              />
            </div>
            <textarea
              value={draft.appendSystemPrompt}
              disabled={loading}
              onChange={(e) => setDraft({ ...draft, appendSystemPrompt: e.target.value })}
              placeholder={t('dispatch.presetPrompt', '职责系统提示词（可选），如"你是测试工程师，只做验证不改业务代码"')}
              rows={2}
              className="w-full text-xs bg-background-base border border-border rounded px-2 py-1.5 text-text-primary placeholder:text-text-muted resize-none"
            />
            <div className="flex items-center gap-2">
              <select
                value={draft.permissionMode}
                disabled={loading}
                onChange={(e) => setDraft({ ...draft, permissionMode: e.target.value })}
                className="text-xs bg-background-base border border-border rounded px-2 py-1.5 text-text-primary"
              >
                {PERMISSION_OPTIONS.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode || t('dispatch.permissionInherit', '权限：继承默认')}
                  </option>
                ))}
              </select>
              <div className="ml-auto flex items-center gap-2">
                {formError && <span className="text-xs text-error">{formError}</span>}
                <button
                  type="button"
                  disabled={loading}
                  onClick={handleAddPreset}
                  className="text-xs px-3 py-1.5 rounded bg-primary text-white hover:bg-primary-hover disabled:opacity-50"
                >
                  {t('dispatch.savePreset', '保存')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
