/**
 * 协议模板管理组件测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProtocolTemplateManager } from './ProtocolTemplateManager';
import type { ProtocolTemplate } from '../../types/scheduler';

// Mock useSchedulerStore
const mockLoadProtocolTemplates = vi.fn();
const mockCreateProtocolTemplate = vi.fn();
const mockUpdateProtocolTemplate = vi.fn();
const mockDeleteProtocolTemplate = vi.fn();
const mockToggleProtocolTemplate = vi.fn();

const mockTemplates: ProtocolTemplate[] = [
  {
    id: 'dev-feature',
    name: '功能开发模板',
    description: '适用于功能开发任务',
    category: 'development',
    builtin: true,
    enabled: true,
    protocolConfig: {
      missionTemplate: '任务目标: {{task}}',
    },
    params: [],
    createdAt: 1000,
    updatedAt: 1000,
  },
  {
    id: 'custom-1',
    name: '自定义模板',
    description: '用户自定义模板',
    category: 'custom',
    builtin: false,
    enabled: true,
    protocolConfig: {
      missionTemplate: '自定义任务: {{task}}',
    },
    params: [
      {
        key: 'param1',
        label: '参数1',
        type: 'text',
        required: true,
      },
    ],
    createdAt: 1000,
    updatedAt: 1000,
  },
  {
    id: 'disabled-1',
    name: '禁用模板',
    description: '被禁用的模板',
    category: 'custom',
    builtin: false,
    enabled: false,
    protocolConfig: {
      missionTemplate: '禁用任务: {{task}}',
    },
    params: [],
    createdAt: 1000,
    updatedAt: 1000,
  },
];

const mockStore = {
  protocolTemplates: mockTemplates,
  protocolTemplatesLoading: false,
  loadProtocolTemplates: mockLoadProtocolTemplates,
  createProtocolTemplate: mockCreateProtocolTemplate,
  updateProtocolTemplate: mockUpdateProtocolTemplate,
  deleteProtocolTemplate: mockDeleteProtocolTemplate,
  toggleProtocolTemplate: mockToggleProtocolTemplate,
};

vi.mock('../../stores', () => ({
  useSchedulerStore: vi.fn(() => mockStore),
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
        'protocolTemplate.title': '协议模板管理',
        'protocolTemplate.builtin': '内置',
        'protocolTemplate.custom': '自定义',
        'protocolTemplate.params': '参数',
        'protocolTemplate.noParams': '无参数',
        'protocolTemplate.nameRequired': '请输入模板名称',
        'protocolTemplate.missionTemplateRequired': '请输入任务目标模板',
        'protocolTemplate.createSuccess': '创建成功',
        'protocolTemplate.updateSuccess': '更新成功',
        'protocolTemplate.deleteSuccess': '删除成功',
        'protocolTemplate.cannotEditBuiltin': '内置模板不可编辑',
        'protocolTemplate.cannotDeleteBuiltin': '内置模板不可删除',
        'protocolTemplate.deleteConfirm': '确认删除此模板？',
        'protocolTemplate.builtinReadOnly': '只读',
        'template.newTemplate': '新建模板',
        'template.editTemplate': '编辑模板',
        'template.enabled': '启用',
        'template.disabled': '禁用',
        'loading': '加载中...',
        'editor.cancel': '取消',
        'editor.save': '保存',
        'card.edit': '编辑',
        'card.delete': '删除',
        'card.enable': '启用',
        'card.disable': '禁用',
        'toast.createFailed': '创建失败',
        'toast.updateFailed': '更新失败',
        'toast.deleteFailed': '删除失败',
      };
      return translations[key] || key;
    },
  }),
}));

// Mock TASK_CATEGORY_LABELS
vi.mock('../../types/scheduler', () => ({
  TASK_CATEGORY_LABELS: {
    development: '开发',
    review: '审查',
    monitoring: '监控',
    news: '新闻',
    custom: '自定义',
  },
  generateProtocolDocument: vi.fn((template, params) => {
    let doc = `# ${template.name}\n\n`;
    doc += `## 任务目标\n${template.protocolConfig.missionTemplate}\n\n`;
    if (template.params.length > 0) {
      doc += `## 参数\n`;
      template.params.forEach((p) => {
        doc += `- ${p.label}: ${params[p.key] || p.defaultValue || '未设置'}\n`;
      });
    }
    return doc;
  }),
}));

describe('ProtocolTemplateManager', () => {
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.protocolTemplates = [...mockTemplates];
    mockStore.protocolTemplatesLoading = false;
  });

  it('renders template list with all templates', () => {
    render(<ProtocolTemplateManager onClose={mockOnClose} />);

    expect(screen.getByText('功能开发模板')).toBeInTheDocument();
    expect(screen.getByText('自定义模板')).toBeInTheDocument();
    expect(screen.getByText('禁用模板')).toBeInTheDocument();
  });

  it('shows builtin badge for builtin templates', () => {
    render(<ProtocolTemplateManager onClose={mockOnClose} />);

    expect(screen.getByText('功能开发模板')).toBeInTheDocument();
    // 内置模板显示 "内置" 标签
    const builtinBadges = screen.getAllByText('内置');
    expect(builtinBadges.length).toBeGreaterThan(0);
  });

  it('shows disabled status for disabled templates', () => {
    render(<ProtocolTemplateManager onClose={mockOnClose} />);

    // 禁用模板显示 "禁用" 标签
    expect(screen.getByText('禁用模板')).toBeInTheDocument();
    const disabledBadges = screen.getAllByText('禁用');
    expect(disabledBadges.length).toBeGreaterThan(0);
  });

  it('shows loading state', () => {
    mockStore.protocolTemplatesLoading = true;
    render(<ProtocolTemplateManager onClose={mockOnClose} />);

    expect(screen.getByText('加载中...')).toBeInTheDocument();
  });

  it('shows empty state when no templates', () => {
    mockStore.protocolTemplates = [];
    render(<ProtocolTemplateManager onClose={mockOnClose} />);

    expect(screen.getByText('protocolTemplate.noTemplates')).toBeInTheDocument();
  });

  it('calls onClose when close button clicked', () => {
    render(<ProtocolTemplateManager onClose={mockOnClose} />);

    // 点击关闭按钮 (头部区域的 ✕)
    const closeButtons = screen.getAllByText('✕');
    fireEvent.click(closeButtons[0]);

    expect(mockOnClose).toHaveBeenCalled();
  });

  it('opens editor when new template button clicked', async () => {
    render(<ProtocolTemplateManager onClose={mockOnClose} />);

    const newButton = screen.getByText(/\+ 新建模板/);
    fireEvent.click(newButton);

    // 编辑器应该打开
    expect(screen.getByText('新建模板')).toBeInTheDocument();
    expect(screen.getByText('protocolTemplate.name')).toBeInTheDocument();
  });

  it('shows template description', () => {
    render(<ProtocolTemplateManager onClose={mockOnClose} />);

    expect(screen.getByText('适用于功能开发任务')).toBeInTheDocument();
    expect(screen.getByText('用户自定义模板')).toBeInTheDocument();
  });

  it('shows template params count', () => {
    render(<ProtocolTemplateManager onClose={mockOnClose} />);

    // 自定义模板有参数
    expect(screen.getByText('参数1')).toBeInTheDocument();
  });

  it('prevents editing builtin templates', async () => {
    render(<ProtocolTemplateManager onClose={mockOnClose} />);

    // 内置模板应该显示只读标签
    const builtinLabels = screen.getAllByText('只读');
    expect(builtinLabels.length).toBeGreaterThan(0);
  });

  it('can toggle template enabled state', async () => {
    render(<ProtocolTemplateManager onClose={mockOnClose} />);

    // 找到自定义模板的启用/禁用按钮
    const disableButtons = screen.getAllByRole('button', { name: '禁用' });
    // 第一个是禁用按钮
    expect(disableButtons.length).toBeGreaterThan(0);
    fireEvent.click(disableButtons[0]);
    expect(mockToggleProtocolTemplate).toHaveBeenCalled();
  });

  it('can delete non-builtin template', async () => {
    render(<ProtocolTemplateManager onClose={mockOnClose} />);

    // 找到删除按钮
    const deleteButtons = screen.getAllByText('删除');
    fireEvent.click(deleteButtons[0]);

    // 显示确认对话框
    expect(screen.getByText('确认删除此模板？')).toBeInTheDocument();
  });

  it('calls createProtocolTemplate when saving new template', async () => {
    mockCreateProtocolTemplate.mockResolvedValueOnce({});

    render(<ProtocolTemplateManager onClose={mockOnClose} />);

    // 打开新建编辑器
    const newButton = screen.getByText(/\+ 新建模板/);
    fireEvent.click(newButton);

    // 填写名称
    const nameInput = document.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: '测试模板' } });

    // 找到任务目标模板输入框 (第一个 textarea)
    const textareas = document.querySelectorAll('textarea');
    fireEvent.change(textareas[0], { target: { value: '测试任务: {{task}}' } });

    // 保存
    const saveButton = screen.getByText('保存');
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockCreateProtocolTemplate).toHaveBeenCalled();
    });
  });

  it('validates required fields when saving', async () => {
    render(<ProtocolTemplateManager onClose={mockOnClose} />);

    // 打开新建编辑器
    const newButton = screen.getByText(/\+ 新建模板/);
    fireEvent.click(newButton);

    // 直接保存（不填写任何内容）
    const saveButton = screen.getByText('保存');
    fireEvent.click(saveButton);

    // 应该显示警告（名称必填）
    // 由于 toast.warning 是 mock，我们验证 createTemplate 没被调用
    expect(mockCreateProtocolTemplate).not.toHaveBeenCalled();
  });

  it('shows template category badge', () => {
    render(<ProtocolTemplateManager onClose={mockOnClose} />);

    expect(screen.getByText('开发')).toBeInTheDocument();
    expect(screen.getAllByText('自定义').length).toBeGreaterThan(0);
  });

  it('loads templates on mount', () => {
    render(<ProtocolTemplateManager onClose={mockOnClose} />);

    expect(mockLoadProtocolTemplates).toHaveBeenCalled();
  });
});

describe('ProtocolTemplateManager - Editor', () => {
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.protocolTemplates = [...mockTemplates];
  });

  it('shows all form fields in editor', async () => {
    render(<ProtocolTemplateManager onClose={mockOnClose} />);

    // 打开编辑器
    const newButton = screen.getByText(/\+ 新建模板/);
    fireEvent.click(newButton);

    // 验证编辑器标题
    expect(screen.getByText('新建模板')).toBeInTheDocument();

    // 验证表单字段存在
    const textInputs = document.querySelectorAll('input[type="text"]');
    expect(textInputs.length).toBeGreaterThan(0);
    const textareas = document.querySelectorAll('textarea');
    expect(textareas.length).toBeGreaterThan(0);
  });

  it('can add and remove params', async () => {
    render(<ProtocolTemplateManager onClose={mockOnClose} />);

    // 打开编辑器
    const newButton = screen.getByText(/\+ 新建模板/);
    fireEvent.click(newButton);

    // 添加参数
    const addParamButton = screen.getByText(/\+ protocolTemplate.addParam/);
    fireEvent.click(addParamButton);

    // 应该显示参数表单
    const paramInputs = document.querySelectorAll('input[type="text"]');
    expect(paramInputs.length).toBeGreaterThan(0);
  });

  it('can edit existing template', async () => {
    render(<ProtocolTemplateManager onClose={mockOnClose} />);

    // 点击自定义模板的编辑按钮
    const editButtons = screen.getAllByRole('button', { name: '编辑' });
    expect(editButtons.length).toBeGreaterThan(0);
    fireEvent.click(editButtons[0]);

    // 编辑器应该显示现有数据
    expect(screen.getByText('编辑模板')).toBeInTheDocument();
  });

  it('can cancel editor', async () => {
    render(<ProtocolTemplateManager onClose={mockOnClose} />);

    // 打开编辑器
    const newButton = screen.getByText(/\+ 新建模板/);
    fireEvent.click(newButton);

    // 验证编辑器打开
    expect(screen.getByText('新建模板')).toBeInTheDocument();

    // 取消
    const cancelButtons = screen.getAllByRole('button', { name: '取消' });
    fireEvent.click(cancelButtons[cancelButtons.length - 1]);

    // 编辑器应该关闭
    expect(screen.queryByText('新建模板')).not.toBeInTheDocument();
  });
});

describe('ProtocolTemplateManager - Delete Confirm', () => {
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.protocolTemplates = [...mockTemplates];
  });

  it('shows delete confirmation dialog', async () => {
    render(<ProtocolTemplateManager onClose={mockOnClose} />);

    // 点击删除按钮
    const deleteButtons = screen.getAllByRole('button', { name: '删除' });
    expect(deleteButtons.length).toBeGreaterThan(0);
    fireEvent.click(deleteButtons[0]);

    // 确认对话框应该显示 - 使用实际翻译文本
    expect(screen.getByText('确认删除此模板？')).toBeInTheDocument();
  });

  it('can cancel delete', async () => {
    render(<ProtocolTemplateManager onClose={mockOnClose} />);

    // 点击删除按钮
    const deleteButtons = screen.getAllByRole('button', { name: '删除' });
    fireEvent.click(deleteButtons[0]);

    // 确认对话框应该显示
    expect(screen.getByText('确认删除此模板？')).toBeInTheDocument();

    // 取消删除 - 找到最后一个取消按钮（确认对话框中的）
    const cancelButtons = screen.getAllByRole('button', { name: '取消' });
    fireEvent.click(cancelButtons[cancelButtons.length - 1]);

    // 确认对话框应该关闭
    expect(screen.queryByText('确认删除此模板？')).not.toBeInTheDocument();
    expect(mockDeleteProtocolTemplate).not.toHaveBeenCalled();
  });

  it('can confirm delete', async () => {
    mockDeleteProtocolTemplate.mockResolvedValueOnce({});

    render(<ProtocolTemplateManager onClose={mockOnClose} />);

    // 点击删除按钮
    const deleteButtons = screen.getAllByRole('button', { name: '删除' });
    fireEvent.click(deleteButtons[0]);

    // 确认对话框应该显示
    expect(screen.getByText('确认删除此模板？')).toBeInTheDocument();

    // 确认删除 - 找到确认对话框中的删除按钮（最后一个）
    const confirmButtons = screen.getAllByRole('button', { name: '删除' });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => {
      expect(mockDeleteProtocolTemplate).toHaveBeenCalledWith('custom-1');
    });
  });
});
