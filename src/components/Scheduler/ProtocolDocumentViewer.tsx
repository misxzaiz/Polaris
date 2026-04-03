/**
 * 协议文档查看器组件
 * 用于查看协议模式任务的文档内容
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ScheduledTask, ProtocolDocuments } from '../../types/scheduler';
import * as tauri from '../../services/tauri';
import { useToastStore } from '../../stores';

export interface ProtocolDocumentViewerProps {
  /** 任务数据 */
  task: ScheduledTask;
  /** 关闭回调 */
  onClose: () => void;
}

type TabType = 'protocol' | 'supplement' | 'memory' | 'tasks';

export function ProtocolDocumentViewer({ task, onClose }: ProtocolDocumentViewerProps) {
  const { t } = useTranslation('scheduler');
  const toast = useToastStore();

  const [activeTab, setActiveTab] = useState<TabType>('protocol');
  const [documents, setDocuments] = useState<ProtocolDocuments | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  // 用户补充 Tab 的分点输入模式
  const [supplementItems, setSupplementItems] = useState<string[]>([]);
  const [newSupplementItem, setNewSupplementItem] = useState('');
  const [supplementSaving, setSupplementSaving] = useState(false);

  // 加载文档
  useEffect(() => {
    if (!task.taskPath) {
      setLoading(false);
      return;
    }

    const loadDocuments = async () => {
      setLoading(true);
      try {
        const docs = await tauri.schedulerReadProtocolDocuments(
          task.taskPath!,
          task.workDir || ''
        );
        setDocuments(docs);
        // 解析用户补充为分点列表
        const supplementText = docs.supplement || '';
        const lines = supplementText.split('\n').filter(line => line.trim().startsWith('- '));
        if (lines.length > 0) {
          setSupplementItems(lines.map(line => line.replace(/^-\s*/, '').trim()));
        } else if (supplementText.trim()) {
          // 如果不是列表格式，作为单个项目
          setSupplementItems([supplementText.trim()]);
        } else {
          setSupplementItems([]);
        }
      } catch (e) {
        console.error('加载协议文档失败:', e);
        toast.error(t('protocolDoc.loadFailed', '加载协议文档失败'), e instanceof Error ? e.message : '');
      } finally {
        setLoading(false);
      }
    };

    loadDocuments();
  }, [task.taskPath, task.workDir, toast, t]);

  // Tab 切换时重置编辑状态
  useEffect(() => {
    setEditing(false);
    setEditContent('');
  }, [activeTab]);

  // 获取当前 Tab 内容
  const getCurrentContent = () => {
    if (!documents) return '';
    switch (activeTab) {
      case 'protocol':
        return documents.protocol;
      case 'supplement':
        return documents.supplement;
      case 'memory':
        return documents.memoryIndex;
      case 'tasks':
        return documents.memoryTasks;
      default:
        return '';
    }
  };

  // Tab 标题
  const tabLabels: Record<TabType, string> = {
    protocol: t('protocolDoc.protocol', '协议文档'),
    supplement: t('protocolDoc.supplement', '用户补充'),
    memory: t('protocolDoc.memory', '记忆索引'),
    tasks: t('protocolDoc.tasks', '任务队列'),
  };

  // 是否是用户补充 Tab（支持直接编辑模式）
  const isSupplementTab = activeTab === 'supplement';

  // 开始编辑
  const handleStartEdit = () => {
    setEditContent(getCurrentContent());
    setEditing(true);
  };

  // 取消编辑
  const handleCancelEdit = () => {
    setEditing(false);
    setEditContent('');
  };

  // 保存编辑
  const handleSave = async () => {
    if (!task.taskPath) return;

    setSaving(true);
    try {
      switch (activeTab) {
        case 'protocol':
          await tauri.schedulerUpdateProtocol(task.taskPath, task.workDir || '', editContent);
          setDocuments((prev) => prev ? { ...prev, protocol: editContent } : null);
          break;
        case 'supplement':
          await tauri.schedulerUpdateSupplement(task.taskPath, task.workDir || '', editContent);
          setDocuments((prev) => prev ? { ...prev, supplement: editContent } : null);
          break;
        case 'memory':
          await tauri.schedulerUpdateMemoryIndex(task.taskPath, task.workDir || '', editContent);
          setDocuments((prev) => prev ? { ...prev, memoryIndex: editContent } : null);
          break;
        case 'tasks':
          await tauri.schedulerUpdateMemoryTasks(task.taskPath, task.workDir || '', editContent);
          setDocuments((prev) => prev ? { ...prev, memoryTasks: editContent } : null);
          break;
      }
      toast.success(t('protocolDoc.saveSuccess', '保存成功'));
      setEditing(false);
      setEditContent('');
    } catch (e) {
      console.error('保存文档失败:', e);
      toast.error(t('protocolDoc.saveFailed', '保存失败'), e instanceof Error ? e.message : '');
    } finally {
      setSaving(false);
    }
  };

  // 将列表转换为用户补充内容
  const formatListToSupplement = (items: string[]): string => {
    if (items.length === 0) return '';
    return items.map(item => `- ${item}`).join('\n');
  };

  // 添加用户补充项
  const handleAddSupplementItem = () => {
    if (!newSupplementItem.trim()) return;
    setSupplementItems(prev => [...prev, newSupplementItem.trim()]);
    setNewSupplementItem('');
  };

  // 删除用户补充项
  const handleRemoveSupplementItem = (index: number) => {
    setSupplementItems(prev => prev.filter((_, i) => i !== index));
  };

  // 上移用户补充项
  const handleMoveSupplementItemUp = (index: number) => {
    if (index === 0) return;
    setSupplementItems(prev => {
      const newItems = [...prev];
      [newItems[index - 1], newItems[index]] = [newItems[index], newItems[index - 1]];
      return newItems;
    });
  };

  // 下移用户补充项
  const handleMoveSupplementItemDown = (index: number) => {
    if (index === supplementItems.length - 1) return;
    setSupplementItems(prev => {
      const newItems = [...prev];
      [newItems[index], newItems[index + 1]] = [newItems[index + 1], newItems[index]];
      return newItems;
    });
  };

  // 清空用户补充
  const handleClearSupplement = async () => {
    if (!task.taskPath || activeTab !== 'supplement') return;

    setSaving(true);
    try {
      await tauri.schedulerClearSupplement(task.taskPath, task.workDir || '');
      const docs = await tauri.schedulerReadProtocolDocuments(
        task.taskPath,
        task.workDir || ''
      );
      setDocuments(docs);
      setSupplementItems([]);
      toast.success(t('protocolDoc.clearSuccess', '已清空用户补充'));
    } catch (e) {
      console.error('清空用户补充失败:', e);
      toast.error(t('protocolDoc.clearFailed', '清空失败'), e instanceof Error ? e.message : '');
    } finally {
      setSaving(false);
    }
  };

  // 保存用户补充（分点输入模式）
  const handleSaveSupplement = async () => {
    if (!task.taskPath) return;

    setSupplementSaving(true);
    try {
      const content = formatListToSupplement(supplementItems);
      await tauri.schedulerUpdateSupplement(task.taskPath, task.workDir || '', content);
      setDocuments((prev) => prev ? { ...prev, supplement: content } : null);
      toast.success(t('protocolDoc.saveSuccess', '保存成功'));
    } catch (e) {
      console.error('保存用户补充失败:', e);
      toast.error(t('protocolDoc.saveFailed', '保存失败'), e instanceof Error ? e.message : '');
    } finally {
      setSupplementSaving(false);
    }
  };

  // 备份文档
  const handleBackup = async () => {
    if (!task.taskPath) return;

    const docName = activeTab === 'memory' ? 'index' : activeTab;
    setSaving(true);
    try {
      await tauri.schedulerBackupDocument(
        task.taskPath,
        task.workDir || '',
        docName,
        getCurrentContent(),
        undefined
      );
      toast.success(t('protocolDoc.backupSuccess', '备份成功'));
    } catch (e) {
      console.error('备份文档失败:', e);
      toast.error(t('protocolDoc.backupFailed', '备份失败'), e instanceof Error ? e.message : '');
    } finally {
      setSaving(false);
    }
  };

  // 没有任务路径
  if (!task.taskPath) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-background-elevated rounded-xl w-[800px] max-h-[85vh] overflow-hidden border border-border-subtle shadow-2xl flex flex-col">
          <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between">
            <h2 className="text-lg font-semibold text-text-primary">
              {t('protocolDoc.title', '协议文档')}
            </h2>
            <button
              onClick={onClose}
              className="text-text-muted hover:text-text-primary transition-colors"
            >
              ✕
            </button>
          </div>
          <div className="flex-1 flex items-center justify-center">
            <p className="text-text-muted">
              {t('protocolDoc.noTaskPath', '此任务不是协议模式或没有关联的文档路径')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background-elevated rounded-xl w-[900px] max-h-[85vh] overflow-hidden border border-border-subtle shadow-2xl flex flex-col">
        {/* 头部 */}
        <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">
              {t('protocolDoc.title', '协议文档')}
            </h2>
            <p className="text-sm text-text-muted mt-0.5">{task.name}</p>
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Tab 栏 */}
        <div className="px-5 py-2 border-b border-border-subtle flex items-center gap-1 bg-background-surface">
          {(Object.keys(tabLabels) as TabType[]).map((tab) => (
            <button
              key={tab}
              onClick={() => {
                setActiveTab(tab);
                setEditing(false);
              }}
              className={`px-4 py-2 text-sm rounded-lg transition-colors ${
                activeTab === tab
                  ? 'bg-primary text-white'
                  : 'text-text-secondary hover:bg-background-hover'
              }`}
            >
              {tabLabels[tab]}
            </button>
          ))}
        </div>

        {/* 内容区 */}
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-text-muted">{t('protocolDoc.loading', '加载中...')}</p>
            </div>
          ) : editing ? (
            <div className="flex-1 min-h-0 flex flex-col">
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="flex-1 min-h-0 w-full p-4 bg-background-base text-text-primary font-mono text-sm resize-none focus:outline-none overflow-auto"
                placeholder={t('protocolDoc.editPlaceholder', '编辑文档内容...')}
              />
              <div className="px-5 py-3 border-t border-border-subtle flex justify-end gap-2 shrink-0">
                <button
                  onClick={handleCancelEdit}
                  disabled={saving}
                  className="px-4 py-2 bg-background-hover text-text-secondary hover:bg-background-active rounded-lg transition-colors"
                >
                  {t('editor.cancel', '取消')}
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors disabled:opacity-50"
                >
                  {saving ? t('protocolDoc.saving', '保存中...') : t('editor.save', '保存')}
                </button>
              </div>
            </div>
          ) : isSupplementTab ? (
            // 用户补充 Tab：分点输入模式
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
              {/* 提示信息 */}
              <div className="px-5 py-3 bg-info-faint border-b border-border-subtle shrink-0">
                <p className="text-sm text-info">
                  {t('protocolDoc.supplementHint', '添加补充内容，AI 将按顺序逐条处理。每条补充独立生效，便于追踪进度。')}
                </p>
              </div>

              {/* 补充项列表 */}
              <div className="flex-1 min-h-0 overflow-auto p-4 space-y-2">
                {supplementItems.length === 0 ? (
                  <div className="text-center text-text-muted py-8">
                    {t('protocolDoc.noSupplements', '暂无补充内容，在下方输入框添加')}
                  </div>
                ) : (
                  supplementItems.map((item, index) => (
                    <div
                      key={index}
                      className="flex items-start gap-2 p-3 bg-background-surface rounded-lg border border-border-subtle group"
                    >
                      <span className="text-text-muted text-sm font-mono shrink-0 mt-0.5">
                        {index + 1}.
                      </span>
                      <span className="flex-1 text-text-primary text-sm break-words">
                        {item}
                      </span>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        <button
                          onClick={() => handleMoveSupplementItemUp(index)}
                          disabled={index === 0}
                          className="p-1 text-text-muted hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
                          title={t('protocolDoc.moveUp', '上移')}
                        >
                          ↑
                        </button>
                        <button
                          onClick={() => handleMoveSupplementItemDown(index)}
                          disabled={index === supplementItems.length - 1}
                          className="p-1 text-text-muted hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
                          title={t('protocolDoc.moveDown', '下移')}
                        >
                          ↓
                        </button>
                        <button
                          onClick={() => handleRemoveSupplementItem(index)}
                          className="p-1 text-text-muted hover:text-danger"
                          title={t('protocolDoc.removeItem', '删除')}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* 添加新补充项 */}
              <div className="px-5 py-3 border-t border-border-subtle shrink-0">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={newSupplementItem}
                    onChange={(e) => setNewSupplementItem(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleAddSupplementItem();
                      }
                    }}
                    placeholder={t('protocolDoc.newSupplementPlaceholder', '输入新的补充内容，按 Enter 添加...')}
                    className="flex-1 px-3 py-2 bg-background-base text-text-primary text-sm rounded-lg border border-border-subtle focus:outline-none focus:border-primary"
                  />
                  <button
                    onClick={handleAddSupplementItem}
                    disabled={!newSupplementItem.trim()}
                    className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {t('protocolDoc.addItem', '添加')}
                  </button>
                </div>
              </div>

              {/* 操作按钮 */}
              <div className="px-5 py-3 border-t border-border-subtle flex justify-between shrink-0">
                <div className="flex gap-2">
                  <button
                    onClick={handleClearSupplement}
                    disabled={saving || supplementSaving}
                    className="px-3 py-1.5 text-sm bg-warning-faint text-warning hover:bg-warning/20 rounded-lg transition-colors disabled:opacity-50"
                  >
                    {t('protocolDoc.clearSupplement', '清空补充')}
                  </button>
                  <button
                    onClick={handleBackup}
                    disabled={saving || supplementSaving}
                    className="px-3 py-1.5 text-sm bg-info-faint text-info hover:bg-info/20 rounded-lg transition-colors disabled:opacity-50"
                  >
                    {t('protocolDoc.backup', '备份文档')}
                  </button>
                </div>
                <button
                  onClick={handleSaveSupplement}
                  disabled={supplementSaving}
                  className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors text-sm disabled:opacity-50"
                >
                  {supplementSaving ? t('protocolDoc.saving', '保存中...') : t('editor.save', '保存')}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="flex-1 min-h-0 overflow-auto p-4">
                <pre className="text-sm text-text-primary font-mono whitespace-pre-wrap break-words">
                  {getCurrentContent() || t('protocolDoc.empty', '暂无内容')}
                </pre>
              </div>
              <div className="px-5 py-3 border-t border-border-subtle flex justify-between shrink-0">
                <div className="flex gap-2">
                  <button
                    onClick={handleBackup}
                    disabled={saving}
                    className="px-3 py-1.5 text-sm bg-info-faint text-info hover:bg-info/20 rounded-lg transition-colors"
                  >
                    {t('protocolDoc.backup', '备份文档')}
                  </button>
                </div>
                <button
                  onClick={handleStartEdit}
                  className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors text-sm"
                >
                  {t('protocolDoc.edit', '编辑')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ProtocolDocumentViewer;
