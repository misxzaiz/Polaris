/**
 * 协议文档查看器组件测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProtocolDocumentViewer } from './ProtocolDocumentViewer';
import type { ScheduledTask } from '../../types/scheduler';

// Mock tauri services
vi.mock('../../services/tauri', () => ({
  schedulerReadProtocolDocuments: vi.fn(),
  schedulerUpdateProtocol: vi.fn(),
  schedulerUpdateSupplement: vi.fn(),
  schedulerUpdateMemoryIndex: vi.fn(),
  schedulerUpdateMemoryTasks: vi.fn(),
  schedulerClearSupplement: vi.fn(),
  schedulerBackupDocument: vi.fn(),
}));

// Mock useToastStore
vi.mock('../../stores', () => ({
  useToastStore: vi.fn(() => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  })),
}));

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'protocolDoc.title': '协议文档',
        'protocolDoc.protocol': '协议文档',
        'protocolDoc.supplement': '用户补充',
        'protocolDoc.memory': '记忆索引',
        'protocolDoc.tasks': '任务队列',
        'protocolDoc.loading': '加载中...',
        'protocolDoc.empty': '暂无内容',
        'protocolDoc.edit': '编辑',
        'protocolDoc.editPlaceholder': '编辑文档内容...',
        'protocolDoc.supplementPlaceholder': '输入用户补充内容，保存后生效...',
        'protocolDoc.saveSuccess': '保存成功',
        'protocolDoc.saveFailed': '保存失败',
        'protocolDoc.loadFailed': '加载失败',
        'protocolDoc.clearSuccess': '已清空用户补充',
        'protocolDoc.clearFailed': '清空失败',
        'protocolDoc.backupSuccess': '备份成功',
        'protocolDoc.backupFailed': '备份失败',
        'protocolDoc.clearSupplement': '清空补充',
        'protocolDoc.backup': '备份文档',
        'protocolDoc.noTaskPath': '此任务不是协议模式或没有关联的文档路径',
        'protocolDoc.saving': '保存中...',
        'editor.cancel': '取消',
        'editor.save': '保存',
      };
      return translations[key] || key;
    },
  }),
}));

// Import after mocks
import * as tauri from '../../services/tauri';

// Mock task data
const mockTask: ScheduledTask = {
  id: 'task-1',
  name: '测试任务',
  description: '测试任务描述',
  status: 'idle',
  mode: 'protocol',
  taskPath: '/path/to/task',
  workDir: '/workspace',
  enabled: true,
  trigger: {
    type: 'manual',
  },
  createdAt: 1000,
  updatedAt: 1000,
};

const mockDocuments = {
  protocol: '# 协议文档\n\n任务目标: 完成测试',
  supplement: '用户补充内容',
  memoryIndex: '# 记忆索引\n\n## 已完成\n- 测试1',
  memoryTasks: '# 任务队列\n\n## 待办\n- 测试2',
};

describe('ProtocolDocumentViewer', () => {
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tauri.schedulerReadProtocolDocuments).mockResolvedValue(mockDocuments);
    vi.mocked(tauri.schedulerUpdateProtocol).mockResolvedValue(undefined);
    vi.mocked(tauri.schedulerUpdateSupplement).mockResolvedValue(undefined);
    vi.mocked(tauri.schedulerUpdateMemoryIndex).mockResolvedValue(undefined);
    vi.mocked(tauri.schedulerUpdateMemoryTasks).mockResolvedValue(undefined);
    vi.mocked(tauri.schedulerClearSupplement).mockResolvedValue(undefined);
    vi.mocked(tauri.schedulerBackupDocument).mockResolvedValue(undefined);
  });

  it('renders loading state initially', async () => {
    vi.mocked(tauri.schedulerReadProtocolDocuments).mockImplementation(() => new Promise(() => {}));

    render(<ProtocolDocumentViewer task={mockTask} onClose={mockOnClose} />);

    expect(screen.getByText('加载中...')).toBeInTheDocument();
  });

  it('renders document viewer with task name', async () => {
    render(<ProtocolDocumentViewer task={mockTask} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText('测试任务')).toBeInTheDocument();
    });
  });

  it('renders all tabs', async () => {
    render(<ProtocolDocumentViewer task={mockTask} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText('测试任务')).toBeInTheDocument();
    });

    // 检查 Tab 标签 - 使用 role 来精确查找按钮
    expect(screen.getByRole('button', { name: '用户补充' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '记忆索引' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '任务队列' })).toBeInTheDocument();
  });

  it('loads and displays protocol document content', async () => {
    render(<ProtocolDocumentViewer task={mockTask} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(tauri.schedulerReadProtocolDocuments).toHaveBeenCalledWith('/path/to/task', '/workspace');
    });

    await waitFor(() => {
      expect(screen.getByText(/任务目标: 完成测试/)).toBeInTheDocument();
    });
  });

  it('shows no task path message when taskPath is missing', () => {
    const taskWithoutPath = { ...mockTask, taskPath: undefined };
    render(<ProtocolDocumentViewer task={taskWithoutPath} onClose={mockOnClose} />);

    expect(screen.getByText('此任务不是协议模式或没有关联的文档路径')).toBeInTheDocument();
  });

  it('closes viewer when close button clicked', async () => {
    render(<ProtocolDocumentViewer task={mockTask} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText('测试任务')).toBeInTheDocument();
    });

    const closeButton = screen.getByText('✕');
    fireEvent.click(closeButton);

    expect(mockOnClose).toHaveBeenCalled();
  });

  it('switches to supplement tab', async () => {
    render(<ProtocolDocumentViewer task={mockTask} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText(/任务目标: 完成测试/)).toBeInTheDocument();
    });

    // 切换到用户补充 Tab
    const supplementTab = screen.getByRole('button', { name: '用户补充' });
    fireEvent.click(supplementTab);

    // 用户补充 Tab 现在是查看模式，显示内容和编辑按钮
    await waitFor(() => {
      expect(screen.getByText('用户补充内容')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '编辑' })).toBeInTheDocument();
    });
  });

  it('shows empty message when document content is empty', async () => {
    vi.mocked(tauri.schedulerReadProtocolDocuments).mockResolvedValue({
      protocol: '',
      supplement: '',
      memoryIndex: '',
      memoryTasks: '',
    });

    render(<ProtocolDocumentViewer task={mockTask} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText('暂无内容')).toBeInTheDocument();
    });
  });

  it('enters edit mode when edit button clicked', async () => {
    render(<ProtocolDocumentViewer task={mockTask} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText('测试任务')).toBeInTheDocument();
    });

    // 等待内容加载完成
    await waitFor(() => {
      expect(screen.getByText(/任务目标: 完成测试/)).toBeInTheDocument();
    });

    const editButton = screen.getByRole('button', { name: '编辑' });
    fireEvent.click(editButton);

    // 应该显示取消和保存按钮
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument();
    });
  });

  it('backs up document when backup button clicked', async () => {
    render(<ProtocolDocumentViewer task={mockTask} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText('测试任务')).toBeInTheDocument();
    });

    // 点击备份按钮
    const backupButton = screen.getByRole('button', { name: '备份文档' });
    fireEvent.click(backupButton);

    await waitFor(() => {
      expect(tauri.schedulerBackupDocument).toHaveBeenCalled();
    });
  });

  it('supplement tab has direct edit mode with save button', async () => {
    render(<ProtocolDocumentViewer task={mockTask} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText('测试任务')).toBeInTheDocument();
    });

    // 切换到用户补充 Tab
    const supplementTab = screen.getByRole('button', { name: '用户补充' });
    fireEvent.click(supplementTab);

    // 用户补充 Tab 现在是查看模式，显示编辑按钮
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '编辑' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '清空补充' })).toBeInTheDocument();
    });

    // 点击编辑按钮进入编辑模式
    const editButton = screen.getByRole('button', { name: '编辑' });
    fireEvent.click(editButton);

    // 编辑模式显示取消和保存按钮
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument();
    });
  });

  it('supplement tab allows editing and saving content', async () => {
    render(<ProtocolDocumentViewer task={mockTask} onClose={mockOnClose} />);

    // Wait for the component to load
    await waitFor(() => {
      expect(screen.getByText('测试任务')).toBeInTheDocument();
    });

    // Wait for content to be loaded (protocol tab by default)
    await waitFor(() => {
      expect(screen.getByText(/任务目标: 完成测试/)).toBeInTheDocument();
    });

    // 切换到用户补充 Tab
    const supplementTab = screen.getByRole('button', { name: '用户补充' });
    fireEvent.click(supplementTab);

    // 等待用户补充内容显示
    await waitFor(() => {
      expect(screen.getByText('用户补充内容')).toBeInTheDocument();
    });

    // 点击编辑按钮进入编辑模式
    const editButton = screen.getByRole('button', { name: '编辑' });
    fireEvent.click(editButton);

    // 等待编辑模式的 textarea 出现
    const textarea = await screen.findByPlaceholderText('编辑文档内容...');
    expect(textarea).toHaveValue('用户补充内容');

    // 修改内容
    fireEvent.change(textarea, { target: { value: '新的用户补充内容' } });

    // 验证 textarea 内容已更新
    await waitFor(() => {
      expect(textarea).toHaveValue('新的用户补充内容');
    });

    // 点击保存按钮应该调用 API
    const saveButton = screen.getByRole('button', { name: '保存' });
    fireEvent.click(saveButton);

    // 验证保存函数被调用
    await waitFor(() => {
      expect(tauri.schedulerUpdateSupplement).toHaveBeenCalled();
    });

    // 验证调用参数包含正确的路径和工作目录
    expect(tauri.schedulerUpdateSupplement).toHaveBeenCalledWith(
      '/path/to/task',
      '/workspace',
      expect.any(String)
    );
  });
});
