/**
 * LSP 语言服务器设置 Tab
 *
 * 功能：使用帮助 / 预设模板一键填充 / 命令存在性校验 / 运行模式（LSP·索引）/
 * 服务器列表（启用·删除·重启）/ 保存时格式化开关。
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useLspStore, type LspServerConfig, type LspConnectionStatus } from '@/stores/lspStore';
import { useEditorSettingsStore } from '@/stores/editorSettingsStore';
import {
  lspConfigUpsert,
  lspConfigRemove,
  lspConfigToggle,
  lspCheckCommand,
} from '@/services/tauri/lspService';
import { KeyCapture } from '@/components/Settings/KeyCapture';
import { IndexEngineSection } from '@/components/Settings/IndexEngineSection';
import { createLogger } from '@/utils/logger';
import {
  Power,
  Trash2,
  Plus,
  RefreshCw,
  Terminal,
  HelpCircle,
  Check,
  X,
  Zap,
} from 'lucide-react';

const log = createLogger('LspTab');

/** 预设模板：常见语言服务器 + 安装提示。点击后填充添加表单。 */
interface LspPreset extends LspServerConfig {
  /** 安装提示（命令或说明） */
  install: string;
}

const PRESETS: LspPreset[] = [
  {
    id: 'typescript-language-server',
    name: 'TypeScript / JavaScript',
    command: 'typescript-language-server',
    args: ['--stdio'],
    languages: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
    mode: 'lsp',
    enabled: true,
    install: 'npm i -g typescript typescript-language-server',
  },
  {
    id: 'pyright',
    name: 'Python (Pyright)',
    command: 'pyright-langserver',
    args: ['--stdio'],
    languages: ['python'],
    mode: 'lsp',
    enabled: true,
    install: 'npm i -g pyright',
  },
  {
    id: 'rust-analyzer',
    name: 'Rust',
    command: 'rust-analyzer',
    args: [],
    languages: ['rust'],
    mode: 'lsp',
    enabled: true,
    install: 'rustup component add rust-analyzer',
  },
  {
    id: 'gopls',
    name: 'Go',
    command: 'gopls',
    args: [],
    languages: ['go'],
    mode: 'lsp',
    enabled: true,
    install: 'go install golang.org/x/tools/gopls@latest',
  },
  {
    id: 'clangd',
    name: 'C / C++ (clangd)',
    command: 'clangd',
    args: [],
    languages: ['c', 'cpp'],
    mode: 'lsp',
    enabled: true,
    install: '安装 LLVM/clangd 并加入 PATH',
  },
  {
    id: 'jdtls',
    name: 'Java (jdtls · 完整功能，吃内存)',
    command: 'jdtls',
    args: [],
    languages: ['java'],
    mode: 'lsp',
    enabled: true,
    install: '下载 Eclipse jdtls 并加入 PATH；低配机建议改用「索引模式」',
  },
  {
    id: 'java-index',
    name: 'Java (索引模式 · 省内存)',
    command: '',
    args: [],
    languages: ['java'],
    mode: 'index',
    enabled: true,
    install: '无需安装，内置 ripgrep 式扫描，零常驻进程',
  },
  {
    id: 'cpp-index',
    name: 'C / C++ (索引模式 · 省内存)',
    command: '',
    args: [],
    languages: ['c', 'cpp'],
    mode: 'index',
    enabled: true,
    install: '无需安装，零常驻进程',
  },
];

/** 状态指示灯颜色 */
function statusDot(status?: LspConnectionStatus): string {
  switch (status) {
    case 'connected': return 'bg-green-500';
    case 'connecting': return 'bg-yellow-500 animate-pulse';
    case 'error': return 'bg-red-500';
    default: return 'bg-gray-500';
  }
}

function statusLabel(status: LspConnectionStatus | undefined, t: (key: string) => string): string {
  switch (status) {
    case 'connected': return t('lsp.status.connected');
    case 'connecting': return t('lsp.status.connecting');
    case 'error': return t('lsp.status.error');
    default: return t('lsp.status.disconnected');
  }
}

type CmdCheck = { checking: boolean; found: boolean | null; path: string | null };

export function LspTab() {
  const { t } = useTranslation('settings');
  const servers = useLspStore((s) => s.servers);
  const status = useLspStore((s) => s.status);
  const toggleServer = useLspStore((s) => s.toggleServer);
  const removeServer = useLspStore((s) => s.removeServer);
  const deactivateServer = useLspStore((s) => s.deactivateServer);
  const addServer = useLspStore((s) => s.addServer);

  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [cmdCheck, setCmdCheck] = useState<CmdCheck>({ checking: false, found: null, path: null });
  const [addForm, setAddForm] = useState<Partial<LspServerConfig>>({
    languages: [],
    args: [],
    enabled: true,
    mode: 'lsp',
  });

  // 从后端加载配置（通过 store action 统一处理）
  const loadConfig = useCallback(async () => {
    try {
      setLoading(true);
      await useLspStore.getState().loadFromBackend();
    } catch (err) {
      log.error('Failed to load LSP config', undefined, { error: String(err) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // 应用预设到表单
  const applyPreset = (preset: LspPreset) => {
    setCmdCheck({ checking: false, found: null, path: null });
    setAddForm({
      id: preset.id,
      name: preset.name,
      command: preset.command,
      args: preset.args,
      languages: preset.languages,
      mode: preset.mode,
      enabled: true,
    });
    setShowAdd(true);
  };

  // 校验命令是否存在
  const checkCommand = async () => {
    const command = addForm.command?.trim();
    if (!command) return;
    setCmdCheck({ checking: true, found: null, path: null });
    try {
      const result = await lspCheckCommand(command);
      setCmdCheck({ checking: false, found: result.found, path: result.resolvedPath });
    } catch (err) {
      log.error('Failed to check command', undefined, { error: String(err) });
      setCmdCheck({ checking: false, found: false, path: null });
    }
  };

  // 切换启用
  const handleToggle = async (id: string) => {
    const server = servers.find((s) => s.id === id);
    if (!server) return;
    const newEnabled = !server.enabled;
    toggleServer(id);
    try {
      await lspConfigToggle(id, newEnabled);
    } catch (err) {
      log.error('Failed to toggle LSP server', undefined, { id, error: String(err) });
      toggleServer(id); // 回滚
    }
  };

  // 重启：断开进程，下次打开对应文件时自动重连
  const handleRestart = async (id: string) => {
    try {
      await deactivateServer(id);
    } catch (err) {
      log.error('Failed to restart LSP server', undefined, { id, error: String(err) });
    }
  };

  // 删除（先调后端，成功再从 store 移除）
  const handleRemove = async (id: string) => {
    try {
      await lspConfigRemove(id);
      await deactivateServer(id);
      removeServer(id);
    } catch (err) {
      log.error('Failed to remove LSP server', undefined, { id, error: String(err) });
    }
  };

  // 索引模式不需要 command；LSP 模式需要
  const isIndexMode = addForm.mode === 'index';
  const canAdd = !!addForm.id && !!addForm.name &&
    (addForm.languages?.length ?? 0) > 0 &&
    (isIndexMode || !!addForm.command);

  // 添加自定义服务器
  const handleAdd = async () => {
    if (!canAdd) return;
    const id = addForm.id?.trim();
    const name = addForm.name?.trim();
    if (!id || !name) return;
    const config: LspServerConfig = {
      id,
      name,
      languages: addForm.languages ?? [],
      command: isIndexMode ? '' : (addForm.command ?? ''),
      args: isIndexMode ? [] : (addForm.args ?? []),
      enabled: addForm.enabled ?? true,
      mode: addForm.mode ?? 'lsp',
    };
    try {
      addServer(config);
      await lspConfigUpsert(config);
      setShowAdd(false);
      setCmdCheck({ checking: false, found: null, path: null });
      setAddForm({ languages: [], args: [], enabled: true, mode: 'lsp' });
    } catch (err) {
      log.error('Failed to add LSP server', undefined, { error: String(err) });
    }
  };

  // format on save 开关（持久化在 editorSettingsStore）
  const formatOnSave = useEditorSettingsStore((s) => s.formatOnSave);
  const setFormatOnSave = useEditorSettingsStore((s) => s.setFormatOnSave);
  // 快捷键自定义
  const lspKeyDefinition = useEditorSettingsStore((s) => s.lspKeyDefinition);
  const lspKeyReferences = useEditorSettingsStore((s) => s.lspKeyReferences);
  const setLspKey = useEditorSettingsStore((s) => s.setLspKey);
  const resetLspKeys = useEditorSettingsStore((s) => s.resetLspKeys);

  const inputCls =
    'bg-background-elevated border border-border-subtle rounded-md px-3 py-1.5 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-primary';

  return (
    <div className="space-y-4">
      {/* 编辑器 LSP 偏好 */}
      <div className="p-3 bg-surface rounded-lg border border-border-subtle flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-text-primary">
            {t('lsp.formatOnSave', { defaultValue: '保存时自动格式化' })}
          </div>
          <div className="text-xs text-text-muted mt-0.5">
            {t('lsp.formatOnSaveHint', {
              defaultValue: '按 Ctrl/Cmd+S 保存前调用 LSP 的 textDocument/formatting；无 LSP 时静默跳过。',
            })}
          </div>
        </div>
        <button
          onClick={() => setFormatOnSave(!formatOnSave)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            formatOnSave ? 'bg-primary' : 'bg-border'
          }`}
          role="switch"
          aria-checked={formatOnSave}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
              formatOnSave ? 'translate-x-5' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {/* LSP 快捷键自定义 */}
      <div className="p-3 bg-surface rounded-lg border border-border-subtle space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-text-primary">
              {t('lsp.shortcuts.title', { defaultValue: 'LSP 快捷键' })}
            </div>
            <div className="text-xs text-text-muted mt-0.5">
              {t('lsp.shortcuts.hint', {
                defaultValue: '点击按钮后按下组合键录制；修改后需重新打开文件生效。',
              })}
            </div>
          </div>
          <button
            onClick={resetLspKeys}
            className="px-2 py-1 text-[11px] rounded-md text-text-secondary hover:bg-surface border border-border-subtle hover:border-primary hover:text-primary transition-colors"
          >
            {t('lsp.shortcuts.reset', { defaultValue: '重置默认' })}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-text-secondary">
              {t('lsp.shortcuts.definition', { defaultValue: '跳转定义' })}
            </span>
            <KeyCapture
              value={lspKeyDefinition}
              onChange={(k) => setLspKey('definition', k)}
              label={t('lsp.shortcuts.definition', { defaultValue: '跳转定义' })}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-text-secondary">
              {t('lsp.shortcuts.references', { defaultValue: '查找引用' })}
            </span>
            <KeyCapture
              value={lspKeyReferences}
              onChange={(k) => setLspKey('references', k)}
              label={t('lsp.shortcuts.references', { defaultValue: '查找引用' })}
            />
          </div>
        </div>

        <div className="text-[11px] text-text-muted">
          {t('lsp.shortcuts.note', {
            defaultValue: '提示：F12 已被系统占用（DevTools 切换）；Ctrl/Cmd+单击 跳转定义始终保留。',
          })}
        </div>
      </div>

      {/* 索引引擎状态（轻量持久化索引：tree-sitter + SQLite） */}
      <IndexEngineSection />

      {/* 标题和操作 */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-secondary">
          {t('lsp.description')}
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => setShowHelp((v) => !v)}
            className="flex items-center gap-1 px-2 py-1.5 text-xs rounded-md text-text-muted hover:text-text-primary hover:bg-surface transition-colors"
            title={t('lsp.help', { defaultValue: '使用帮助' })}
          >
            <HelpCircle size={13} />
            {t('lsp.help', { defaultValue: '使用帮助' })}
          </button>
          <button
            onClick={loadConfig}
            disabled={loading}
            className="p-1.5 rounded-md hover:bg-surface text-text-muted hover:text-text-primary transition-colors"
            title={t('lsp.refresh')}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => setShowAdd(!showAdd)}
            className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
          >
            <Plus size={12} />
            {t('lsp.addServer')}
          </button>
        </div>
      </div>

      {/* 使用帮助 */}
      {showHelp && (
        <div className="p-4 bg-surface rounded-lg border border-border-subtle space-y-3 text-xs text-text-secondary">
          <div className="font-medium text-text-primary text-sm">
            {t('lsp.helpTitle', { defaultValue: '如何新增语言服务器（3 步）' })}
          </div>
          <ol className="list-decimal list-inside space-y-1.5">
            <li>
              {t('lsp.helpStep1', {
                defaultValue: '先安装服务器本体（Polaris 不自带）。下方预设附带安装命令，点一下即可填好配置。',
              })}
            </li>
            <li>
              {t('lsp.helpStep2', {
                defaultValue: 'languages 必须用系统语言名（小写）：C++ 填 cpp，C# 填 csharp。',
              })}
            </li>
            <li>
              {t('lsp.helpStep3', {
                defaultValue: '打开一个该语言的文件触发连接，状态灯变绿即成功；变红可点「重启」。',
              })}
            </li>
          </ol>

          <div className="font-medium text-text-primary pt-1">
            {t('lsp.helpPresetsTitle', { defaultValue: '常见服务器与安装方式' })}
          </div>
          <div className="space-y-1">
            {PRESETS.filter((p) => p.mode === 'lsp').map((p) => (
              <div key={p.id} className="flex items-start gap-2">
                <span className="text-text-primary min-w-[140px] flex-shrink-0">{p.name}</span>
                <code className="text-[11px] text-text-muted font-mono break-all">{p.install}</code>
              </div>
            ))}
          </div>

          <div className="p-2 rounded-md bg-primary/5 border border-primary/20 flex gap-2">
            <Zap size={14} className="text-primary flex-shrink-0 mt-0.5" />
            <div>
              <div className="text-text-primary font-medium">
                {t('lsp.helpLowSpecTitle', { defaultValue: '低配机 / 重型语言（Java、C++）' })}
              </div>
              <div className="mt-0.5">
                {t('lsp.helpLowSpec', {
                  defaultValue:
                    'Java 的 jdtls 会启动 JVM、常驻数百 MB 内存。低配机可改用「索引模式」：基于全词扫描提供跳转定义与查找引用，零常驻进程，不占内存（不含补全/诊断）。',
                })}
              </div>
            </div>
          </div>

          <div className="text-text-muted">
            {t('lsp.helpShortcuts', {
              defaultValue: '默认快捷键：Ctrl/Cmd+Alt+B 跳转定义 · Alt+Shift+R 查找引用 · Ctrl/Cmd+单击 跳转定义（保留）· Ctrl/Cmd+Shift+O 文件符号。可在上方「LSP 快捷键」自定义。',
            })}
          </div>
        </div>
      )}

      {/* 预设模板快捷入口 */}
      {showAdd && (
        <div className="flex flex-wrap gap-1.5">
          <span className="text-[11px] text-text-muted self-center mr-1">
            {t('lsp.presets', { defaultValue: '预设：' })}
          </span>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => applyPreset(p)}
              className="flex items-center gap-1 px-2 py-1 text-[11px] rounded-md border border-border-subtle text-text-secondary hover:border-primary hover:text-primary transition-colors"
            >
              {p.mode === 'index' && <Zap size={10} />}
              {p.name}
            </button>
          ))}
        </div>
      )}

      {/* 添加表单 */}
      {showAdd && (
        <div className="p-4 bg-surface rounded-lg border border-border-subtle space-y-3">
          <h4 className="text-sm font-medium text-text-primary">{t('lsp.addTitle')}</h4>

          {/* 运行模式选择 */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted">{t('lsp.mode', { defaultValue: '模式' })}</span>
            <div className="flex rounded-md overflow-hidden border border-border-subtle">
              <button
                onClick={() => setAddForm((f) => ({ ...f, mode: 'lsp' }))}
                className={`px-3 py-1 text-xs transition-colors ${
                  !isIndexMode ? 'bg-primary text-white' : 'text-text-secondary hover:bg-surface'
                }`}
              >
                {t('lsp.modeLsp', { defaultValue: 'LSP（完整）' })}
              </button>
              <button
                onClick={() => setAddForm((f) => ({ ...f, mode: 'index' }))}
                className={`px-3 py-1 text-xs transition-colors flex items-center gap-1 ${
                  isIndexMode ? 'bg-primary text-white' : 'text-text-secondary hover:bg-surface'
                }`}
              >
                <Zap size={11} />
                {t('lsp.modeIndex', { defaultValue: '索引（省内存）' })}
              </button>
            </div>
            <span className="text-[11px] text-text-muted flex-1">
              {isIndexMode
                ? t('lsp.modeIndexHint', { defaultValue: '无需安装、零常驻进程；提供跳转/查引用，无补全诊断。' })
                : t('lsp.modeLspHint', { defaultValue: '启动语言服务器进程，提供补全/诊断/语义导航。' })}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <input
              type="text"
              placeholder={t('lsp.idPlaceholder')}
              value={addForm.id ?? ''}
              onChange={(e) => setAddForm((f) => ({ ...f, id: e.target.value }))}
              className={inputCls}
            />
            <input
              type="text"
              placeholder={t('lsp.namePlaceholder')}
              value={addForm.name ?? ''}
              onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
              className={inputCls}
            />

            {/* LSP 模式才需要命令/参数 */}
            {!isIndexMode && (
              <>
                <div className="relative flex items-center">
                  <input
                    type="text"
                    placeholder={t('lsp.commandPlaceholder')}
                    value={addForm.command ?? ''}
                    onChange={(e) => {
                      setAddForm((f) => ({ ...f, command: e.target.value }));
                      setCmdCheck({ checking: false, found: null, path: null });
                    }}
                    className={`${inputCls} w-full pr-16`}
                  />
                  <button
                    onClick={checkCommand}
                    disabled={!addForm.command || cmdCheck.checking}
                    className="absolute right-1 px-2 py-0.5 text-[11px] rounded text-primary hover:bg-primary/10 disabled:opacity-40"
                  >
                    {cmdCheck.checking
                      ? '…'
                      : t('lsp.checkCommand', { defaultValue: '检测' })}
                  </button>
                </div>
                <input
                  type="text"
                  placeholder={t('lsp.argsPlaceholder')}
                  value={addForm.args?.join(' ') ?? ''}
                  onChange={(e) => setAddForm((f) => ({
                    ...f,
                    args: e.target.value.split(/\s+/).filter(Boolean),
                  }))}
                  className={inputCls}
                />
              </>
            )}

            <input
              type="text"
              placeholder={t('lsp.languagesPlaceholder')}
              value={addForm.languages?.join(', ') ?? ''}
              onChange={(e) => setAddForm((f) => ({
                ...f,
                languages: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
              }))}
              className={`${inputCls} col-span-2`}
            />
          </div>

          {/* 命令校验结果 */}
          {!isIndexMode && cmdCheck.found !== null && (
            <div className={`flex items-center gap-1.5 text-xs ${cmdCheck.found ? 'text-green-500' : 'text-danger'}`}>
              {cmdCheck.found ? <Check size={13} /> : <X size={13} />}
              {cmdCheck.found
                ? t('lsp.checkFound', { defaultValue: '已找到：' }) + (cmdCheck.path ?? '')
                : t('lsp.checkNotFound', { defaultValue: '未检测到该可执行文件，请先安装并确认它在 PATH 中。' })}
            </div>
          )}

          <div className="flex gap-2 justify-end">
            <button
              onClick={() => { setShowAdd(false); setCmdCheck({ checking: false, found: null, path: null }); }}
              className="px-3 py-1.5 text-xs rounded-md text-text-secondary hover:bg-surface transition-colors"
            >
              {t('lsp.cancel')}
            </button>
            <button
              onClick={handleAdd}
              disabled={!canAdd}
              className="px-3 py-1.5 text-xs rounded-md bg-primary text-white hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {t('lsp.add')}
            </button>
          </div>
        </div>
      )}

      {/* 服务器列表 */}
      <div className="space-y-2">
        {servers.map((server) => {
          const connStatus = status.get(server.id);
          const indexMode = server.mode === 'index';
          return (
            <div
              key={server.id}
              className={`p-4 rounded-lg border transition-colors ${
                server.enabled
                  ? 'bg-surface border-border-subtle'
                  : 'bg-surface/50 border-border-subtle/50 opacity-60'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  {/* 开关 */}
                  <button
                    onClick={() => handleToggle(server.id)}
                    className={`p-1.5 rounded-md transition-colors flex-shrink-0 ${
                      server.enabled
                        ? 'text-primary bg-primary/10 hover:bg-primary/20'
                        : 'text-text-muted hover:bg-surface'
                    }`}
                    title={server.enabled ? t('lsp.disable') : t('lsp.enable')}
                  >
                    <Power size={14} />
                  </button>

                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-primary truncate">
                        {server.name}
                      </span>
                      {/* 模式徽标 */}
                      <span
                        className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded ${
                          indexMode
                            ? 'bg-primary/10 text-primary'
                            : 'bg-surface text-text-muted border border-border-subtle'
                        }`}
                      >
                        {indexMode && <Zap size={9} />}
                        {indexMode
                          ? t('lsp.badgeIndex', { defaultValue: '索引' })
                          : t('lsp.badgeLsp', { defaultValue: 'LSP' })}
                      </span>
                      {/* 索引模式无连接状态灯 */}
                      {!indexMode && (
                        <span className="inline-flex items-center gap-1 text-[10px] text-text-muted">
                          <span className={`w-1.5 h-1.5 rounded-full ${statusDot(connStatus)}`} />
                          {statusLabel(connStatus, t)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      {!indexMode && (
                        <code className="text-[11px] text-text-muted font-mono truncate">
                          {server.command} {server.args.join(' ')}
                        </code>
                      )}
                      <span className="text-[10px] text-text-tertiary">
                        {server.languages.join(', ')}
                      </span>
                    </div>
                  </div>
                </div>

                {/* 操作按钮 */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  {/* 重启：仅 LSP 模式且已连接/出错时显示 */}
                  {!indexMode && (connStatus === 'connected' || connStatus === 'error') && (
                    <button
                      onClick={() => handleRestart(server.id)}
                      className="p-1.5 rounded-md text-text-muted hover:text-primary hover:bg-primary/10 transition-colors"
                      title={t('lsp.restart', { defaultValue: '重启（下次打开文件时重连）' })}
                    >
                      <RefreshCw size={13} />
                    </button>
                  )}
                  <button
                    onClick={() => handleRemove(server.id)}
                    className="p-1.5 rounded-md text-text-muted hover:text-danger hover:bg-danger/10 transition-colors"
                    title={t('lsp.delete')}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            </div>
          );
        })}

        {servers.length === 0 && (
          <div className="text-center py-8 text-text-muted text-sm">
            <Terminal size={24} className="mx-auto mb-2 opacity-50" />
            <p>{t('lsp.noServers')}</p>
            <p className="text-xs mt-1">{t('lsp.noServersHint')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
