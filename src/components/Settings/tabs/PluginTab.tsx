/**
 * Plugin 管理 Tab
 *
 * 提供插件浏览、安装、启用/禁用、更新、卸载功能
 * 使用虚拟滚动支持大量插件列表
 */

import { useState, useEffect, useMemo, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Virtuoso } from 'react-virtuoso';
import { usePluginStore, useToastStore } from '../../../stores';
import { Button } from '../../Common';
import type { InstalledPlugin, AvailablePlugin, PluginScope, McpServerConfig } from '../../../types/plugin';

// 格式化 ISO 时间为本地时间
const formatDateTime = (isoString?: string): string => {
  if (!isoString) return '-';
  try {
    const date = new Date(isoString);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoString;
  }
};

// MCP 服务器配置渲染组件
const McpServerCard = memo<{
  name: string;
  config: McpServerConfig;
  mcpType: string;
  mcpUrl: string;
  mcpCommand: string;
}>(({ name, config, mcpType, mcpUrl, mcpCommand }) => (
  <div className="text-sm bg-surface p-3 rounded border border-border-subtle">
    <div className="font-medium text-text-primary mb-2">{name}</div>
    <div className="space-y-1 text-xs">
      <div className="flex">
        <span className="w-12 flex-shrink-0 text-text-secondary">{mcpType}:</span>
        <span className="text-text-primary uppercase">{config.type || 'stdio'}</span>
      </div>
      {config.url && (
        <div className="flex">
          <span className="w-12 flex-shrink-0 text-text-secondary">{mcpUrl}:</span>
          <span className="text-text-primary break-all">{config.url}</span>
        </div>
      )}
      {config.command && (
        <div className="flex">
          <span className="w-12 flex-shrink-0 text-text-secondary">{mcpCommand}:</span>
          <span className="text-text-primary font-mono">
            {config.command} {config.args?.join(' ')}
          </span>
        </div>
      )}
    </div>
  </div>
));

McpServerCard.displayName = 'McpServerCard';

// 虚拟列表项类型
type VirtualItem =
  | { type: 'section'; key: string; title: string; count: number }
  | { type: 'installed'; key: string; plugin: InstalledPlugin }
  | { type: 'available'; key: string; plugin: AvailablePlugin; isInstalled: boolean };

export function PluginTab() {
  const { t } = useTranslation('settings');
  const { success, error: toastError } = useToastStore();
  const {
    installed,
    available,
    marketplaces,
    selectedPlugin,
    loading,
    availableLoading,
    error,
    operatingPluginId,
    fetchInstalled,
    fetchAvailable,
    fetchMarketplaces,
    selectInstalledPlugin,
    selectAvailablePlugin,
    selectPlugin,
    installPlugin,
    enablePlugin,
    disablePlugin,
    updatePlugin,
    uninstallPlugin,
    clearError,
  } = usePluginStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedScope, setSelectedScope] = useState<PluginScope>('user');
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'install' | 'uninstall' | null>(null);

  // 初始化加载
  useEffect(() => {
    fetchInstalled();
    fetchAvailable();
    fetchMarketplaces();
  }, [fetchInstalled, fetchAvailable, fetchMarketplaces]);

  // 过滤插件
  const filteredInstalled = useMemo(
    () => installed.filter((p) => p.id.toLowerCase().includes(searchQuery.toLowerCase())),
    [installed, searchQuery]
  );

  const filteredAvailable = useMemo(
    () =>
      available.filter(
        (p) =>
          p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          p.pluginId.toLowerCase().includes(searchQuery.toLowerCase())
      ),
    [available, searchQuery]
  );

  // 构建虚拟列表数据
  const virtualItems = useMemo((): VirtualItem[] => {
    const items: VirtualItem[] = [];
    const installedIds = new Set(installed.map((p) => p.id));

    // 已安装区块
    if (filteredInstalled.length > 0 || !loading) {
      items.push({
        type: 'section',
        key: 'installed-section',
        title: t('plugins.installed', '已安装'),
        count: filteredInstalled.length,
      });
      filteredInstalled.forEach((plugin) => {
        items.push({ type: 'installed', key: plugin.id, plugin });
      });
    }

    // 可用区块
    items.push({
      type: 'section',
      key: 'available-section',
      title: t('plugins.available', '可用插件'),
      count: filteredAvailable.length,
    });
    filteredAvailable.forEach((plugin) => {
      items.push({
        type: 'available',
        key: plugin.pluginId,
        plugin,
        isInstalled: installedIds.has(plugin.pluginId),
      });
    });

    return items;
  }, [filteredInstalled, filteredAvailable, installed, loading, t]);

  // 处理安装
  const handleInstall = async () => {
    if (!selectedPlugin) return;
    const result = await installPlugin(selectedPlugin.id, selectedScope);
    if (result) {
      success(t('plugins.installSuccess', '插件安装成功'));
      selectPlugin(null);
    } else {
      toastError(t('plugins.installFailed', '插件安装失败'));
    }
    setShowConfirmModal(false);
    setConfirmAction(null);
  };

  // 处理启用/禁用
  const handleToggle = async (plugin: InstalledPlugin) => {
    const result = plugin.enabled
      ? await disablePlugin(plugin.id, plugin.scope as PluginScope)
      : await enablePlugin(plugin.id, plugin.scope as PluginScope);
    if (result) {
      success(
        plugin.enabled
          ? t('plugins.disableSuccess', '插件已禁用')
          : t('plugins.enableSuccess', '插件已启用')
      );
    }
  };

  // 处理更新
  const handleUpdate = async (plugin: InstalledPlugin) => {
    const result = await updatePlugin(plugin.id, plugin.scope as PluginScope);
    if (result) {
      success(t('plugins.updateSuccess', '插件更新成功'));
    }
  };

  // 处理卸载
  const handleUninstall = async () => {
    if (!selectedPlugin) return;
    const plugin = installed.find((p) => p.id === selectedPlugin.id);
    if (!plugin) return;
    const result = await uninstallPlugin(plugin.id, plugin.scope as PluginScope, false);
    if (result) {
      success(t('plugins.uninstallSuccess', '插件已卸载'));
    }
    setShowConfirmModal(false);
    setConfirmAction(null);
  };

  // 打开确认弹窗
  const openConfirmModal = (action: 'install' | 'uninstall') => {
    setConfirmAction(action);
    setShowConfirmModal(true);
  };

  // 点击插件项
  const handleItemClick = (item: VirtualItem) => {
    if (item.type === 'installed') {
      selectInstalledPlugin(item.plugin.id);
    } else if (item.type === 'available') {
      selectAvailablePlugin(item.plugin.pluginId);
    }
  };

  return (
    <div className="flex h-[500px] gap-4">
      {/* 左侧：插件列表 */}
      <div className="w-1/2 flex flex-col border border-border rounded-lg overflow-hidden">
        {/* 搜索栏 */}
        <div className="p-3 border-b border-border">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('plugins.search', '搜索插件...')}
            className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary"
          />
        </div>

        {/* 插件列表 - 虚拟滚动 */}
        <div className="flex-1 overflow-hidden">
          {loading || availableLoading ? (
            <div className="flex justify-center py-8">
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : virtualItems.length <= 2 ? (
            <div className="flex flex-col items-center justify-center py-8 text-text-muted">
              <span className="text-sm">{t('plugins.noAvailable', '暂无可用插件')}</span>
            </div>
          ) : (
            <Virtuoso
              style={{ height: '100%' }}
              data={virtualItems}
              itemContent={(_index, item) => (
                <VirtualItemRenderer
                  item={item}
                  selectedPluginId={selectedPlugin?.id}
                  operatingPluginId={operatingPluginId}
                  onClick={() => handleItemClick(item)}
                  onUpdate={() => {
                    if (item.type === 'installed') {
                      handleUpdate(item.plugin);
                    }
                  }}
                />
              )}
              defaultItemHeight={40}
            />
          )}
        </div>

        {/* 市场选择 */}
        <div className="p-3 border-t border-border bg-surface">
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <span>{t('plugins.market', '市场')}:</span>
            {marketplaces.map((m) => (
              <span key={m.name} className="px-2 py-0.5 bg-border rounded">
                {m.name}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* 右侧：插件详情 */}
      <div className="w-1/2 border border-border rounded-lg overflow-hidden">
        {selectedPlugin ? (
          <div className="h-full flex flex-col">
            {/* 详情头部 */}
            <div className="p-4 border-b border-border">
              <h3 className="font-medium text-text-primary">{selectedPlugin.name}</h3>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-xs text-text-muted">{selectedPlugin.id}</span>
                {selectedPlugin.installed && (
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      selectedPlugin.enabled
                        ? 'bg-green-500/10 text-green-500'
                        : 'bg-yellow-500/10 text-yellow-500'
                    }`}
                  >
                    {selectedPlugin.enabled
                      ? t('plugins.enabled', '已启用')
                      : t('plugins.disabled', '已禁用')}
                  </span>
                )}
              </div>
            </div>

            {/* 详情内容 */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {selectedPlugin.description && (
                <div>
                  <h4 className="text-xs font-medium text-text-secondary uppercase mb-1">
                    {t('plugins.description', '描述')}
                  </h4>
                  <p className="text-sm text-text-primary">{selectedPlugin.description}</p>
                </div>
              )}

              {selectedPlugin.version && (
                <div>
                  <h4 className="text-xs font-medium text-text-secondary uppercase mb-1">
                    {t('plugins.version', '版本')}
                  </h4>
                  <p className="text-sm text-text-primary">{selectedPlugin.version}</p>
                </div>
              )}

              {selectedPlugin.marketplaceName && (
                <div>
                  <h4 className="text-xs font-medium text-text-secondary uppercase mb-1">
                    {t('plugins.market', '市场')}
                  </h4>
                  <p className="text-sm text-text-primary">{selectedPlugin.marketplaceName}</p>
                </div>
              )}

              {selectedPlugin.installCount !== undefined && (
                <div>
                  <h4 className="text-xs font-medium text-text-secondary uppercase mb-1">
                    {t('plugins.installCount', '安装数量')}
                  </h4>
                  <p className="text-sm text-text-primary">{selectedPlugin.installCount.toLocaleString()}</p>
                </div>
              )}

              {/* 已安装插件的额外信息 */}
              {selectedPlugin.installed && (
                <>
                  {selectedPlugin.scope && (
                    <div>
                      <h4 className="text-xs font-medium text-text-secondary uppercase mb-1">
                        {t('plugins.installScope', '安装范围')}
                      </h4>
                      <p className="text-sm text-text-primary">
                        {t(`plugins.scope.${selectedPlugin.scope}`, selectedPlugin.scope)}
                      </p>
                    </div>
                  )}

                  {selectedPlugin.installPath && (
                    <div>
                      <h4 className="text-xs font-medium text-text-secondary uppercase mb-1">
                        {t('plugins.installPath', '安装路径')}
                      </h4>
                      <p className="text-sm text-text-primary font-mono break-all bg-surface p-2 rounded">
                        {selectedPlugin.installPath}
                      </p>
                    </div>
                  )}

                  {selectedPlugin.installedAt && (
                    <div>
                      <h4 className="text-xs font-medium text-text-secondary uppercase mb-1">
                        {t('plugins.installedAt', '安装时间')}
                      </h4>
                      <p className="text-sm text-text-primary">{formatDateTime(selectedPlugin.installedAt)}</p>
                    </div>
                  )}

                  {selectedPlugin.lastUpdated && (
                    <div>
                      <h4 className="text-xs font-medium text-text-secondary uppercase mb-1">
                        {t('plugins.lastUpdated', '更新时间')}
                      </h4>
                      <p className="text-sm text-text-primary">{formatDateTime(selectedPlugin.lastUpdated)}</p>
                    </div>
                  )}
                </>
              )}

              {/* MCP 服务器配置 */}
              {selectedPlugin.mcpServers && Object.keys(selectedPlugin.mcpServers).length > 0 && (
                <div>
                  <h4 className="text-xs font-medium text-text-secondary uppercase mb-2">
                    {t('plugins.mcpServers', 'MCP 服务')}
                  </h4>
                  <div className="space-y-2">
                    {Object.entries(selectedPlugin.mcpServers).map(([name, config]) => (
                      <McpServerCard
                        key={name}
                        name={name}
                        config={config}
                        mcpType={t('plugins.mcpType', '类型')}
                        mcpUrl={t('plugins.mcpUrl', '地址')}
                        mcpCommand={t('plugins.mcpCommand', '命令')}
                      />
                    ))}
                  </div>
                </div>
              )}

              {error && (
                <div className="p-3 bg-red-500/10 border border-red-500/30 rounded text-red-500 text-sm">
                  {error}
                  <button onClick={clearError} className="ml-2 underline">
                    {t('common.dismiss', '关闭')}
                  </button>
                </div>
              )}
            </div>

            {/* 操作按钮 */}
            <div className="p-4 border-t border-border space-y-2">
              {selectedPlugin.installed ? (
                <>
                  <div className="flex gap-2">
                    <Button
                      variant={selectedPlugin.enabled ? 'secondary' : 'primary'}
                      onClick={() =>
                        selectedPlugin.enabled
                          ? handleToggle(installed.find((p) => p.id === selectedPlugin.id)!)
                          : handleToggle(installed.find((p) => p.id === selectedPlugin.id)!)
                      }
                      disabled={operatingPluginId === selectedPlugin.id}
                      className="flex-1"
                    >
                      {selectedPlugin.enabled
                        ? t('plugins.disable', '禁用')
                        : t('plugins.enable', '启用')}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => handleUpdate(installed.find((p) => p.id === selectedPlugin.id)!)}
                      disabled={operatingPluginId === selectedPlugin.id}
                      className="flex-1"
                    >
                      {t('plugins.update', '更新')}
                    </Button>
                  </div>
                  <Button
                    variant="ghost"
                    onClick={() => openConfirmModal('uninstall')}
                    disabled={operatingPluginId === selectedPlugin.id}
                    className="w-full text-red-500 hover:bg-red-500/10"
                  >
                    {t('plugins.uninstall', '卸载')}
                  </Button>
                </>
              ) : (
                <Button
                  variant="primary"
                  onClick={() => openConfirmModal('install')}
                  disabled={operatingPluginId === selectedPlugin.id}
                  className="w-full"
                >
                  {t('plugins.install', '安装')}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-text-muted">
            {t('plugins.selectToView', '选择一个插件查看详情')}
          </div>
        )}
      </div>

      {/* 确认弹窗 */}
      {showConfirmModal && selectedPlugin && (
        <ConfirmModal
          title={
            confirmAction === 'install'
              ? t('plugins.confirmInstall', '确认安装')
              : t('plugins.confirmUninstall', '确认卸载')
          }
          message={
            confirmAction === 'install'
              ? t('plugins.confirmInstallDesc', '确定要安装 {{name}} 吗？', {
                  name: selectedPlugin.name,
                })
              : t('plugins.confirmUninstallDesc', '确定要卸载 {{name}} 吗？', {
                  name: selectedPlugin.name,
                })
          }
          scope={selectedScope}
          onScopeChange={setSelectedScope}
          showScopeSelect={confirmAction === 'install'}
          onConfirm={confirmAction === 'install' ? handleInstall : handleUninstall}
          onCancel={() => {
            setShowConfirmModal(false);
            setConfirmAction(null);
          }}
          loading={operatingPluginId === selectedPlugin.id}
        />
      )}
    </div>
  );
}

// 虚拟列表项渲染器
const VirtualItemRenderer = memo<{
  item: VirtualItem;
  selectedPluginId?: string;
  operatingPluginId: string | null;
  onClick: () => void;
  onUpdate: () => void;
}>(({ item, selectedPluginId, operatingPluginId, onClick, onUpdate }) => {
  if (item.type === 'section') {
    return (
      <div className="px-3 py-2 sticky top-0 bg-background-elevated z-10">
        <h3 className="text-xs font-medium text-text-secondary uppercase">
          {item.title} ({item.count})
        </h3>
      </div>
    );
  }

  if (item.type === 'installed') {
    const { plugin } = item;
    const isSelected = selectedPluginId === plugin.id;
    const isOperating = operatingPluginId === plugin.id;

    return (
      <div
        onClick={onClick}
        className={`px-3 py-2 mx-3 my-0.5 rounded cursor-pointer transition-colors ${
          isSelected ? 'bg-primary/10 border border-primary/30' : 'hover:bg-surface'
        }`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`w-2 h-2 rounded-full flex-shrink-0 ${
                plugin.enabled ? 'bg-green-500' : 'bg-yellow-500'
              }`}
            />
            <span className="text-sm text-text-primary truncate">{plugin.id.split('@')[0]}</span>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onUpdate();
            }}
            disabled={isOperating}
            className="text-xs px-2 py-1 text-text-muted hover:text-text-primary disabled:opacity-50"
          >
            {plugin.version}
          </button>
        </div>
      </div>
    );
  }

  // type === 'available'
  const { plugin, isInstalled } = item;
  const isSelected = selectedPluginId === plugin.pluginId;

  return (
    <div
      onClick={onClick}
      className={`px-3 py-2 mx-3 my-0.5 rounded cursor-pointer transition-colors ${
        isSelected ? 'bg-primary/10 border border-primary/30' : 'hover:bg-surface'
      } ${isInstalled ? 'opacity-50' : ''}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm text-text-primary truncate">{plugin.name}</span>
          {isInstalled && (
            <span className="text-xs px-1 py-0.5 bg-green-500/10 text-green-500 rounded flex-shrink-0">
              ✓
            </span>
          )}
        </div>
        {plugin.installCount && (
          <span className="text-xs text-text-muted flex-shrink-0">
            {plugin.installCount > 1000
              ? `${(plugin.installCount / 1000).toFixed(0)}k`
              : plugin.installCount}
          </span>
        )}
      </div>
    </div>
  );
});

VirtualItemRenderer.displayName = 'VirtualItemRenderer';

// 确认弹窗
function ConfirmModal({
  title,
  message,
  scope,
  onScopeChange,
  showScopeSelect,
  onConfirm,
  onCancel,
  loading,
}: {
  title: string;
  message: string;
  scope: PluginScope;
  onScopeChange: (scope: PluginScope) => void;
  showScopeSelect: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const { t } = useTranslation('settings');

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background-elevated rounded-lg p-6 max-w-md w-full mx-4 shadow-lg">
        <h3 className="text-lg font-medium text-text-primary mb-2">{title}</h3>
        <p className="text-sm text-text-secondary mb-4">{message}</p>

        {showScopeSelect && (
          <div className="mb-4">
            <label className="block text-xs font-medium text-text-secondary mb-2">
              {t('plugins.installScope', '安装范围')}
            </label>
            <div className="space-y-2">
              {(['user', 'project', 'local'] as PluginScope[]).map((s) => (
                <label key={s} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="scope"
                    value={s}
                    checked={scope === s}
                    onChange={() => onScopeChange(s)}
                    className="w-4 h-4"
                  />
                  <span className="text-sm text-text-primary">
                    {t(`plugins.scope.${s}`, s)}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={loading}>
            {t('common.cancel', '取消')}
          </Button>
          <Button variant="primary" onClick={onConfirm} disabled={loading}>
            {loading ? t('common.processing', '处理中...') : t('common.confirm', '确认')}
          </Button>
        </div>
      </div>
    </div>
  );
}
