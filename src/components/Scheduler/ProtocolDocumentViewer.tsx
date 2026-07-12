/**
 * 协议文档查看器组件
 * 用于查看协议模式任务的文档内容
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ScheduledTask, ProtocolDocuments } from '@/types/scheduler';
import * as tauri from '@/services/tauri';
import { useToastStore } from '@/stores';
import { createLogger } from '@/utils/logger';

const log = createLogger('ProtocolDocViewer');

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

  // 加载文档
  useEffect(() => {
    if (!task.taskPath) {
      setLoading(false);
      return;
    }

    const loadDocuments = async () => {
      setLoading(true);
      try {
        const path = task.taskPath
        if (!path) return
        const docs = await tauri.schedulerReadProtocolDocuments(
          path,
          task.workDir || ''
        );
        setDocuments(docs);
      } catch (e) {
        log.error('Failed to load protocol documents', e instanceof Error ? e : new Error(String(e)));
        toast.error(t('protocolDoc.loadFailed'), e instanceof Error ? e.message : '');
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
    protocol: t('protocolDoc.protocol'),
    supplement: t('protocolDoc.supplement'),
    memory: t('protocolDoc.memory'),
    tasks: t('protocolDoc.tasks'),
  };

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
      toast.success(t('protocolDoc.saveSuccess'));
      setEditing(false);
      setEditContent('');
    } catch (e) {
      log.error('Failed to save document', e instanceof Error ? e : new Error(String(e)));
      toast.error(t('protocolDoc.saveFailed'), e instanceof Error ? e.message : '');
    } finally {
      setSaving(false);
    }
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
      toast.success(t('protocolDoc.clearSuccess'));
    } catch (e) {
      log.error('Failed to clear user supplements', e instanceof Error ? e : new Error(String(e)));
      toast.error(t('protocolDoc.clearFailed'), e instanceof Error ? e.message : '');
    } finally {
      setSaving(false);
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
      toast.success(t('protocolDoc.backupSuccess'));
    } catch (e) {
      log.error('Failed to backup document', e instanceof Error ? e : new Error(String(e)));
      toast.error(t('protocolDoc.backupFailed'), e instanceof Error ? e.message : '');
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
              {t('protocolDoc.title')}
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
              {t('protocolDoc.noTaskPath')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background-elevated rounded-xl w-[900px] h-[85vh] overflow-hidden border border-border-subtle shadow-2xl flex flex-col">
        {/* 头部 */}
        <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">
              {t('protocolDoc.title')}
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
              <p className="text-text-muted">{t('protocolDoc.loading')}</p>
            </div>
          ) : editing ? (
            <div className="flex-1 min-h-0 flex flex-col">
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="flex-1 min-h-0 w-full p-4 bg-background-base text-text-primary font-mono text-sm resize-none focus:outline-none overflow-auto"
                placeholder={t('protocolDoc.editPlaceholder')}
              />
              <div className="px-5 py-3 border-t border-border-subtle flex justify-end gap-2 shrink-0">
                <button
                  onClick={handleCancelEdit}
                  disabled={saving}
                  className="px-4 py-2 bg-background-hover text-text-secondary hover:bg-background-active rounded-lg transition-colors"
                >
                  {t('editor.cancel')}
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors disabled:opacity-50"
                >
                  {saving ? t('protocolDoc.saving') : t('editor.save')}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="flex-1 min-h-0 overflow-auto p-4">
                <pre className="text-sm text-text-primary font-mono whitespace-pre-wrap break-words">
                  {getCurrentContent() || t('protocolDoc.empty')}
                </pre>
              </div>
              <div className="px-5 py-3 border-t border-border-subtle flex justify-between shrink-0">
                <div className="flex gap-2">
                  {activeTab === 'supplement' && (
                    <button
                      onClick={handleClearSupplement}
                      disabled={saving}
                      className="px-3 py-1.5 text-sm bg-warning-faint text-warning hover:bg-warning/20 rounded-lg transition-colors disabled:opacity-50"
                    >
                      {t('protocolDoc.clearSupplement')}
                    </button>
                  )}
                  <button
                    onClick={handleBackup}
                    disabled={saving}
                    className="px-3 py-1.5 text-sm bg-info-faint text-info hover:bg-info/20 rounded-lg transition-colors"
                  >
                    {t('protocolDoc.backup')}
                  </button>
                </div>
                <button
                  onClick={handleStartEdit}
                  className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors text-sm"
                >
                  {t('protocolDoc.edit')}
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
