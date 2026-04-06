/**
 * 系统提示词设置 Tab
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSystemPromptStore } from '../../../services/systemPromptStore';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import i18n from 'i18next';

/** 可用变量列表 */
const AVAILABLE_VARIABLES = [
  { name: '{{workspaceName}}', descKey: 'variables.workspaceName' },
  { name: '{{workspacePath}}', descKey: 'variables.workspacePath' },
  { name: '{{contextWorkspaces}}', descKey: 'variables.contextWorkspaces' },
  { name: '{{date}}', descKey: 'variables.date' },
  { name: '{{time}}', descKey: 'variables.time' },
];

/**
 * 构建默认系统提示词模板（带变量占位符）
 */
function buildDefaultPromptTemplate(): string {
  const t = i18n.t.bind(i18n);
  const lines: string[] = [];

  lines.push(t('systemPrompt:workingIn', { name: '{{workspaceName}}' }));
  lines.push(t('systemPrompt:projectPath', { path: '{{workspacePath}}' }));
  lines.push(t('systemPrompt:fileRefSyntax'));
  lines.push('');
  lines.push(t('systemPrompt:contextWorkspaces'));
  lines.push('{{contextWorkspaces}}');
  lines.push('');
  lines.push(t('systemPrompt:workspaceToolGuidance'));

  return lines.join('\n');
}

/**
 * 构建带实际值的默认提示词
 */
function buildDefaultPromptWithValues(
  workspaceName: string,
  workspacePath: string,
  contextWorkspaces: Array<{ name: string; path: string }>
): string {
  const t = i18n.t.bind(i18n);
  const lines: string[] = [];

  lines.push(t('systemPrompt:workingIn', { name: workspaceName }));
  lines.push(t('systemPrompt:projectPath', { path: workspacePath }));
  lines.push(t('systemPrompt:fileRefSyntax'));

  if (contextWorkspaces.length > 0) {
    lines.push('');
    lines.push(t('systemPrompt:contextWorkspaces'));
    for (const ws of contextWorkspaces) {
      lines.push(`- ${ws.name} (${ws.path})`);
      lines.push(`  ${t('systemPrompt:refSyntax', { name: ws.name })}`);
    }
  }

  lines.push('');
  lines.push(t('systemPrompt:workspaceToolGuidance'));

  return lines.join('\n');
}

export function SystemPromptTab() {
  const { t } = useTranslation('settings');
  const { config, setCustomPrompt, setEnabled, reset } = useSystemPromptStore();
  const { getCurrentWorkspace, getContextWorkspaces } = useWorkspaceStore();
  const [showVariables, setShowVariables] = useState(false);

  const handleInsertVariable = (variable: string) => {
    setCustomPrompt(config.customPrompt + variable);
  };

  const handleFillDefault = () => {
    const currentWorkspace = getCurrentWorkspace();
    const contextWorkspaces = getContextWorkspaces();

    if (currentWorkspace) {
      // 有工作区时，填入带实际值的提示词
      const prompt = buildDefaultPromptWithValues(
        currentWorkspace.name,
        currentWorkspace.path,
        contextWorkspaces.filter(w => w?.name && w?.path).map(w => ({ name: w.name, path: w.path }))
      );
      setCustomPrompt(prompt);
    } else {
      // 无工作区时，填入模板
      setCustomPrompt(buildDefaultPromptTemplate());
    }
  };

  const handleReset = () => {
    if (window.confirm(t('systemPrompt.resetConfirm', '确定要重置为默认设置吗？'))) {
      reset();
    }
  };

  return (
    <div className="space-y-6">
      {/* 启用开关 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-text-primary">
              {t('systemPrompt.enable', '启用自定义系统提示词')}
            </h3>
            <p className="text-xs text-text-secondary mt-1">
              {t('systemPrompt.enableDesc', '启用后可自定义发送给 AI 的系统提示词（工作区信息始终保留）')}
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-9 h-5 bg-surface-hover rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary"></div>
          </label>
        </div>
      </div>

      {/* 自定义提示词编辑器 */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-text-primary">
            {t('systemPrompt.customPrompt', '自定义提示词')}
          </h3>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleFillDefault}
              disabled={!config.enabled}
              className={`text-xs text-primary hover:underline ${
                !config.enabled ? 'opacity-50 cursor-not-allowed' : ''
              }`}
            >
              {t('systemPrompt.fillDefault', '填入默认')}
            </button>
            <button
              type="button"
              onClick={() => setShowVariables(!showVariables)}
              className="text-xs text-primary hover:underline"
            >
              {showVariables
                ? t('systemPrompt.hideVariables', '隐藏变量')
                : t('systemPrompt.showVariables', '显示变量')}
            </button>
          </div>
        </div>

        {/* 变量列表 */}
        {showVariables && (
          <div className="mb-3 p-3 bg-background-faint rounded-lg">
            <div className="text-xs text-text-secondary mb-2">
              {t('systemPrompt.variablesHint', '点击变量可插入到下方编辑器：')}
            </div>
            <div className="flex flex-wrap gap-2">
              {AVAILABLE_VARIABLES.map((v) => (
                <button
                  key={v.name}
                  type="button"
                  onClick={() => handleInsertVariable(v.name)}
                  disabled={!config.enabled}
                  className={`px-2 py-1 text-xs rounded bg-background-surface border border-border-subtle hover:border-primary transition-colors ${
                    !config.enabled ? 'opacity-50 cursor-not-allowed' : ''
                  }`}
                  title={t(`systemPrompt.${v.descKey}`, v.name)}
                >
                  {v.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <textarea
          value={config.customPrompt}
          onChange={(e) => setCustomPrompt(e.target.value)}
          disabled={!config.enabled}
          placeholder={t(
            'systemPrompt.placeholder',
            '输入自定义系统提示词...\n\n可用变量:\n{{workspaceName}} - 当前工作区名称\n{{workspacePath}} - 当前工作区路径\n{{contextWorkspaces}} - 关联工作区列表\n{{date}} - 当前日期\n{{time}} - 当前时间\n{{defaultPrompt}} - 默认系统提示词'
          )}
          className={`w-full h-48 p-3 bg-background rounded-lg border border-border-subtle text-sm text-text-primary placeholder-text-muted resize-y focus:outline-none focus:border-primary ${
            !config.enabled ? 'opacity-50 cursor-not-allowed' : ''
          }`}
        />

        {/* 字数统计 */}
        <div className="flex justify-between items-center mt-2">
          <span className="text-xs text-text-muted">
            {t('systemPrompt.charCount', '{{count}} 字符', { count: config.customPrompt.length })}
          </span>
          <button
            type="button"
            onClick={handleReset}
            className="text-xs text-text-secondary hover:text-danger transition-colors"
          >
            {t('systemPrompt.reset', '重置为默认')}
          </button>
        </div>
      </div>

      {/* 预览 */}
      {config.enabled && config.customPrompt.trim() && (
        <div className="p-4 bg-surface rounded-lg border border-border">
          <h3 className="text-sm font-medium text-text-primary mb-3">
            {t('systemPrompt.preview', '预览')}
          </h3>
          <div className="p-3 bg-background-faint rounded-lg text-xs font-mono whitespace-pre-wrap text-text-secondary max-h-48 overflow-y-auto">
            {config.customPrompt}
          </div>
          <p className="text-xs text-text-muted mt-2">
            {t('systemPrompt.previewNote', '此内容会作为系统提示词发送，工作区信息会自动追加')}
          </p>
        </div>
      )}
    </div>
  );
}
