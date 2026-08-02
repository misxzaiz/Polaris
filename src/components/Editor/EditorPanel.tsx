/**
 * 编辑器面板组件
 */

import { useFileEditorStore } from '@/stores';
import { CodeMirrorEditor } from './Editor';
import { EditorHeader } from './EditorHeader';
import { MarkdownEditor } from './MarkdownEditor';
import { StatusBar } from './StatusBar';

interface EditorPanelProps {
  className?: string;
  /** 可选: Tab 中指定的文件路径 */
  filePath?: string;
}

export function EditorPanel({ className = '', filePath: _filePath }: EditorPanelProps) {
  const { currentFile, setContent, saveFile, isOpen, status, error } = useFileEditorStore();

  // 显示错误状态
  if (error) {
    return (
      <div className={`h-full flex flex-col ${className}`}>
        <div className="flex-1 flex items-center justify-center text-danger text-sm px-4">
          <div className="text-center">
            <div className="text-lg mb-2">⚠️</div>
            <div>{error}</div>
          </div>
        </div>
      </div>
    );
  }

  if (!isOpen || !currentFile) {
    return (
      <div className={`h-full flex flex-col ${className}`}>
        <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">
          {status === 'loading' ? '加载中...' : '未打开文件'}
        </div>
      </div>
    );
  }

  // 判断是否为 Markdown 文件
  const isMarkdown = currentFile.language === 'markdown';

  return (
    <div className={`h-full flex flex-col bg-background-base ${className}`}>
      <EditorHeader />
      <div className="flex-1 overflow-hidden">
        {isMarkdown ? (
          // Markdown 文件使用 MarkdownEditor（支持编辑/预览切换）
          <MarkdownEditor
            key={currentFile.path}
            value={currentFile.content}
            onChange={setContent}
            onSave={saveFile}
          />
        ) : (
          // 其他文件使用普通 CodeMirror 编辑器
          <CodeMirrorEditor
            key={currentFile.path}
            value={currentFile.content}
            language={currentFile.language}
            onChange={setContent}
            onSave={saveFile}
            filePath={currentFile.path}
          />
        )}
      </div>
      <StatusBar />
    </div>
  );
}
