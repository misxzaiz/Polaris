/**
 * 协议模板选择器组件测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProtocolTemplateSelector, TemplateParamsForm } from './ProtocolTemplateSelector';
import type { ProtocolTemplate, TemplateParam } from '../../types/scheduler';

// Mock useSchedulerStore
const mockLoadProtocolTemplates = vi.fn();
const mockStore = {
  protocolTemplates: [
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
      id: 'review-code',
      name: '代码审查模板',
      description: '适用于代码审查任务',
      category: 'review',
      builtin: true,
      enabled: true,
      protocolConfig: {
        missionTemplate: '审查目标: {{task}}',
      },
      params: [],
      createdAt: 1000,
      updatedAt: 1000,
    },
    {
      id: 'custom-1',
      name: '自定义模板',
      description: '用户自定义模板',
      category: 'development',
      builtin: false,
      enabled: true,
      protocolConfig: {
        missionTemplate: '自定义: {{task}}',
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
      category: 'development',
      builtin: false,
      enabled: false,
      protocolConfig: {
        missionTemplate: '禁用: {{task}}',
      },
      params: [],
      createdAt: 1000,
      updatedAt: 1000,
    },
  ] as ProtocolTemplate[],
  protocolTemplatesLoading: false,
  loadProtocolTemplates: mockLoadProtocolTemplates,
};

vi.mock('../../stores', () => ({
  useSchedulerStore: vi.fn(() => mockStore),
}));

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'protocolTemplate.loading': 'Loading...',
        'protocolTemplate.noTemplate': 'No template',
        'protocolTemplate.builtin': 'Built-in',
        'protocolTemplate.params': 'Parameters',
        'protocolTemplate.noParams': 'No parameters',
        'protocolTemplate.selectPlaceholder': 'Please select',
      };
      return translations[key] || key;
    },
  }),
}));

// Mock TASK_CATEGORY_LABELS
vi.mock('../../types/scheduler', () => ({
  TASK_CATEGORY_LABELS: {
    development: 'Development',
    review: 'Review',
    monitoring: 'Monitoring',
    news: 'News',
    custom: 'Custom',
  },
}));

describe('ProtocolTemplateSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders template selector with options grouped by category', () => {
    const onChange = vi.fn();
    render(<ProtocolTemplateSelector onChange={onChange} />);

    // Should have empty option
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.getByText('No template')).toBeInTheDocument();

    // Should show templates in select options (text is split across elements)
    expect(screen.getByText(/功能开发模板/)).toBeInTheDocument();
    expect(screen.getByText(/代码审查模板/)).toBeInTheDocument();
    expect(screen.getByText('自定义模板')).toBeInTheDocument();

    // Should not show disabled templates
    expect(screen.queryByText('禁用模板')).not.toBeInTheDocument();
  });

  it('filters templates by category', () => {
    const onChange = vi.fn();
    render(<ProtocolTemplateSelector onChange={onChange} category="development" as TaskCategory />);

    // Should show development templates
    expect(screen.getByText(/功能开发模板/)).toBeInTheDocument();
    expect(screen.getByText('自定义模板')).toBeInTheDocument();

    // Should not show review templates
    expect(screen.queryByText(/代码审查模板/)).not.toBeInTheDocument();
  });

  it('calls onChange when template is selected', () => {
    const onChange = vi.fn();
    render(<ProtocolTemplateSelector onChange={onChange} />);

    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'dev-feature' } });

    expect(onChange).toHaveBeenCalledWith(
      'dev-feature',
      expect.objectContaining({
        id: 'dev-feature',
        name: '功能开发模板',
      })
    );
  });

  it('shows template description when selected', () => {
    const onChange = vi.fn();
    render(<ProtocolTemplateSelector value="dev-feature" onChange={onChange} />);

    expect(screen.getByText('功能开发模板')).toBeInTheDocument();
    expect(screen.getByText('适用于功能开发任务')).toBeInTheDocument();
    expect(screen.getByText('Built-in')).toBeInTheDocument();
  });

  it('disables selector when disabled prop is true', () => {
    const onChange = vi.fn();
    render(<ProtocolTemplateSelector onChange={onChange} disabled />);

    expect(screen.getByRole('combobox')).toBeDisabled();
  });
});

describe('TemplateParamsForm', () => {
  const mockParams: TemplateParam[] = [
    {
      key: 'text_param',
      label: 'Text Parameter',
      type: 'text',
      required: true,
      placeholder: 'Enter text',
    },
    {
      key: 'textarea_param',
      label: 'Textarea Parameter',
      type: 'textarea',
      required: false,
    },
    {
      key: 'select_param',
      label: 'Select Parameter',
      type: 'select',
      required: false,
      options: [
        { value: 'option1', label: 'Option 1' },
        { value: 'option2', label: 'Option 2' },
      ],
    },
    {
      key: 'number_param',
      label: 'Number Parameter',
      type: 'number',
      required: false,
    },
    {
      key: 'date_param',
      label: 'Date Parameter',
      type: 'date',
      required: false,
    },
  ];

  it('renders no params message when params is empty', () => {
    const onChange = vi.fn();
    render(<TemplateParamsForm params={[]} values={{}} onChange={onChange} />);

    expect(screen.getByText('No parameters')).toBeInTheDocument();
  });

  it('renders all parameter types', () => {
    const onChange = vi.fn();
    render(<TemplateParamsForm params={mockParams} values={{}} onChange={onChange} />);

    expect(screen.getByText('Text Parameter')).toBeInTheDocument();
    expect(screen.getByText('Textarea Parameter')).toBeInTheDocument();
    expect(screen.getByText('Select Parameter')).toBeInTheDocument();
    expect(screen.getByText('Number Parameter')).toBeInTheDocument();
    expect(screen.getByText('Date Parameter')).toBeInTheDocument();
  });

  it('shows required indicator', () => {
    const onChange = vi.fn();
    render(<TemplateParamsForm params={mockParams} values={{}} onChange={onChange} />);

    const requiredIndicators = screen.getAllByText('*');
    expect(requiredIndicators.length).toBeGreaterThan(0);
  });

  it('calls onChange when text input changes', () => {
    const onChange = vi.fn();
    render(<TemplateParamsForm params={mockParams} values={{}} onChange={onChange} />);

    const textInput = screen.getByPlaceholderText('Enter text');
    fireEvent.change(textInput, { target: { value: 'test value' } });

    expect(onChange).toHaveBeenCalledWith({
      text_param: 'test value',
    });
  });

  it('disables all inputs when disabled prop is true', () => {
    const onChange = vi.fn();
    render(<TemplateParamsForm params={mockParams} values={{}} onChange={onChange} disabled />);

    const textInput = screen.getByPlaceholderText('Enter text');
    expect(textInput).toBeDisabled();
  });

  it('shows placeholder text', () => {
    const onChange = vi.fn();
    render(<TemplateParamsForm params={mockParams} values={{}} onChange={onChange} />);

    expect(screen.getByText('Enter text')).toBeInTheDocument();
  });
});
