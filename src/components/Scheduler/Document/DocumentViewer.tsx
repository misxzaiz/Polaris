/**
 * 文档查看器组件
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useDocumentStore } from '../../../stores/documentStore';

interface DocumentViewerProps {
  /** 任务 ID */
  taskId: string;
  /** 是否只读 */
  readOnly?: boolean;
}

export function DocumentViewer({
  taskId,
  readOnly = true,
}: DocumentViewerProps) {
  const { t } = useTranslation();
  const { currentWorkspace, loading, loadWorkspace, updateDocument } = useDocumentStore();
  const [activeTab, setActiveTab] = useState<string>('task');
  const [editingContent, setEditingContent] = useState<string>('');

  useEffect(() => {
    loadWorkspace(taskId);
  }, [taskId, loadWorkspace]);

  useEffect(() => {
    if (currentWorkspace) {
      const activeDoc = currentWorkspace.documents.find(d => d.filename === activeTab);
      if (activeDoc) {
        setEditingContent(activeDoc.content);
      }
    }
  }, [currentWorkspace, activeTab]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex items-center gap-2 text-text-tertiary">
          <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          {t('document.loading', '加载文档...')}
        </div>
      </div>
    );
  }

  if (!currentWorkspace) {
    return (
      <div className="flex items-center justify-center h-full text-text-tertiary">
        {t('document.noWorkspace', '暂无文档工作区')}
      </div>
    );
  }

  const documents = currentWorkspace.documents;
  const activeDocument = documents.find(d => d.filename === activeTab) ?? documents[0];

  const handleSave = async () => {
    if (!activeDocument) return;
    await updateDocument(activeDocument.filename, editingContent);
  };

  return (
    <div className="flex flex-col h-full">
      {/* 文档标签页 */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-background-surface">
        {documents.map(doc => (
          <button
            key={doc.filename}
            type="button"
            onClick={() => setActiveTab(doc.filename)}
            className={`
              px-3 py-1 text-sm rounded-t transition-colors
              ${activeTab === doc.filename
                ? 'bg-background-base text-text-primary border-b-2 border-primary'
                : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'
              }
            `}
          >
            <span className="flex items-center gap-1">
              {getDocumentIcon(doc.type)}
              {doc.filename.split('/').pop()}
              {doc.isPrimary && (
                <span className="text-xs text-primary">*</span>
              )}
            </span>
          </button>
        ))}
      </div>

      {/* 文档内容 */}
      <div className="flex-1 overflow-hidden">
        {readOnly ? (
          <DocumentPreview content={activeDocument?.content ?? ''} />
        ) : (
          <DocumentEditor
            content={editingContent}
            onChange={setEditingContent}
            onSave={handleSave}
          />
        )}
      </div>

      {/* 工具栏 */}
      {!readOnly && (
        <div className="flex items-center justify-end gap-2 px-4 py-2 border-t border-border bg-background-surface">
          <button
            type="button"
            onClick={handleSave}
            className="px-4 py-1.5 text-sm bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors"
          >
            {t('common.save', '保存')}
          </button>
        </div>
      )}
    </div>
  );
}

/** 获取文档图标 */
function getDocumentIcon(type: string): string {
  switch (type) {
    case 'task':
      return '📋';
    case 'user':
      return '✏️';
    case 'memory':
      return '🧠';
    default:
      return '📄';
  }
}

/** 文档预览 */
function DocumentPreview({ content }: { content: string }) {
  return (
    <div className="h-full overflow-auto p-4">
      <pre className="whitespace-pre-wrap font-mono text-sm text-text-primary">
        {content}
      </pre>
    </div>
  );
}

/** 文档编辑器 */
function DocumentEditor({
  content,
  onChange,
  onSave,
}: {
  content: string;
  onChange: (content: string) => void;
  onSave: () => void;
}) {
  return (
    <textarea
      value={content}
      onChange={e => onChange(e.target.value)}
      onKeyDown={e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
          e.preventDefault();
          onSave();
        }
      }}
      className="w-full h-full p-4 bg-transparent font-mono text-sm text-text-primary resize-none focus:outline-none"
      spellCheck={false}
    />
  );
}

export default DocumentViewer;
