/**
 * LSP 语言服务器设置 Tab
 *
 * 功能：服务器列表、启用/禁用开关、连接状态、安装/卸载、自定义服务器
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useLspStore, type LspServerConfig, type LspConnectionStatus } from '../../../stores/lspStore';
import { lspConfigUpsert, lspConfigRemove, lspConfigToggle } from '../../../services/tauri/lspService';
import { createLogger } from '../../../utils/logger';
import { Power, Trash2, Plus, RefreshCw, Terminal } from 'lucide-react';

const log = createLogger('LspTab');

/** 状态指示灯颜色 */
function statusDot(status?: LspConnectionStatus): string {
  switch (status) {
    case 'connected': return 'bg-green-500';
    case 'connecting': return 'bg-yellow-500 animate-pulse';
    case 'error': return 'bg-red-500';
    default: return 'bg-gray-500';
  }
}

function statusLabel(status?: LspConnectionStatus): string {
  switch (status) {
    case 'connected': return '已连接';
    case 'connecting': return '连接中...';
    case 'error': return '错误';
    default: return '未连接';
  }
}

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
  const [addForm, setAddForm] = useState<Partial<LspServerConfig>>({
    languages: [],
    args: [],
    enabled: true,
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

  // 删除（先调后端，成功再从 store 移除）
  const handleRemove = async (id: string) => {
    try {
      await lspConfigRemove(id);
      await deactivateServer(id);
      removeServer(id);
    } catch (err) {
      log.error('Failed to remove LSP server', undefined, { id, error: String(err) });
      // 后端删除失败时 store 不动，避免状态不一致
    }
  };

  // 添加自定义服务器
  const handleAdd = async () => {
    if (!addForm.id || !addForm.name || !addForm.command) return;
    const config: LspServerConfig = {
      id: addForm.id,
      name: addForm.name,
      languages: addForm.languages ?? [],
      command: addForm.command,
      args: addForm.args ?? [],
      enabled: addForm.enabled ?? true,
    };
    try {
      addServer(config);
      await lspConfigUpsert(config);
      setShowAdd(false);
      setAddForm({ languages: [], args: [], enabled: true });
    } catch (err) {
      log.error('Failed to add LSP server', undefined, { error: String(err) });
    }
  };

  return (
    <div className="space-y-4">
      {/* 标题和操作 */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-secondary">
          管理编辑器中的语言服务器（LSP），提供代码补全、诊断、跳转定义等功能。
        </p>
        <div className="flex gap-2">
          <button
            onClick={loadConfig}
            disabled={loading}
            className="p-1.5 rounded-md hover:bg-surface text-text-muted hover:text-text-primary transition-colors"
            title="刷新"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => setShowAdd(!showAdd)}
            className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
          >
            <Plus size={12} />
            添加服务器
          </button>
        </div>
      </div>

      {/* 添加表单 */}
      {showAdd && (
        <div className="p-4 bg-surface rounded-lg border border-border-subtle space-y-3">
          <h4 className="text-sm font-medium text-text-primary">添加自定义语言服务器</h4>
          <div className="grid grid-cols-2 gap-3">
            <input
              type="text"
              placeholder="ID（如: rust-analyzer）"
              value={addForm.id ?? ''}
              onChange={(e) => setAddForm((f) => ({ ...f, id: e.target.value }))}
              className="bg-background-elevated border border-border-subtle rounded-md px-3 py-1.5 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-primary"
            />
            <input
              type="text"
              placeholder="名称（如: Rust Analyzer）"
              value={addForm.name ?? ''}
              onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
              className="bg-background-elevated border border-border-subtle rounded-md px-3 py-1.5 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-primary"
            />
            <input
              type="text"
              placeholder="命令（如: rust-analyzer）"
              value={addForm.command ?? ''}
              onChange={(e) => setAddForm((f) => ({ ...f, command: e.target.value }))}
              className="bg-background-elevated border border-border-subtle rounded-md px-3 py-1.5 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-primary"
            />
            <input
              type="text"
              placeholder="语言（逗号分隔，如: rust）"
              value={addForm.languages?.join(', ') ?? ''}
              onChange={(e) => setAddForm((f) => ({
                ...f,
                languages: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
              }))}
              className="bg-background-elevated border border-border-subtle rounded-md px-3 py-1.5 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-primary"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => setShowAdd(false)}
              className="px-3 py-1.5 text-xs rounded-md text-text-secondary hover:bg-surface transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleAdd}
              disabled={!addForm.id || !addForm.name || !addForm.command}
              className="px-3 py-1.5 text-xs rounded-md bg-primary text-white hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              添加
            </button>
          </div>
        </div>
      )}

      {/* 服务器列表 */}
      <div className="space-y-2">
        {servers.map((server) => {
          const connStatus = status.get(server.id);
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
                <div className="flex items-center gap-3">
                  {/* 开关 */}
                  <button
                    onClick={() => handleToggle(server.id)}
                    className={`p-1.5 rounded-md transition-colors ${
                      server.enabled
                        ? 'text-primary bg-primary/10 hover:bg-primary/20'
                        : 'text-text-muted hover:bg-surface'
                    }`}
                    title={server.enabled ? '禁用' : '启用'}
                  >
                    <Power size={14} />
                  </button>

                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-primary">
                        {server.name}
                      </span>
                      <span className="inline-flex items-center gap-1 text-[10px] text-text-muted">
                        <span className={`w-1.5 h-1.5 rounded-full ${statusDot(connStatus)}`} />
                        {statusLabel(connStatus)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <code className="text-[11px] text-text-muted font-mono">
                        {server.command} {server.args.join(' ')}
                      </code>
                      <span className="text-[10px] text-text-tertiary">
                        {server.languages.join(', ')}
                      </span>
                    </div>
                  </div>
                </div>

                {/* 操作按钮 */}
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => handleRemove(server.id)}
                    className="p-1.5 rounded-md text-text-muted hover:text-danger hover:bg-danger/10 transition-colors"
                    title="删除"
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
            <p>暂无语言服务器配置</p>
            <p className="text-xs mt-1">点击"添加服务器"来配置</p>
          </div>
        )}
      </div>
    </div>
  );
}
