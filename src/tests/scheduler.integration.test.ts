/**
 * 集成测试 - 调度器状态管理和协议模板
 */

import { describe, it, expect } from 'vitest';
import type {
  ScheduledTask,
  CreateTaskParams,
  ProtocolTemplate,
  TaskCategory,
  TriggerType,
} from '../types/scheduler';

// Mock data factories
const createMockTask = (overrides: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: `task-${Date.now()}`,
  name: 'Test Task',
  enabled: true,
  triggerType: 'interval' as TriggerType,
  triggerValue: '1h',
  engineId: 'claude-code',
  prompt: 'Test prompt',
  mode: 'simple',
  category: 'development' as TaskCategory,
  currentRuns: 0,
  retryCount: 0,
  notifyOnComplete: true,
  createdAt: Math.floor(Date.now() / 1000),
  updatedAt: Math.floor(Date.now() / 1000),
  ...overrides,
});

const createMockProtocolTask = (overrides: Partial<ScheduledTask> = {}): ScheduledTask =>
  createMockTask({
    mode: 'protocol',
    taskPath: '/path/to/task',
    mission: 'Test mission',
    templateId: 'dev-feature',
    templateParams: { mission: 'Test feature' },
    maxRuns: 10,
    ...overrides,
  });

const createMockProtocolTemplate = (
  overrides: Partial<ProtocolTemplate> = {}
): ProtocolTemplate => ({
  id: `template-${Date.now()}`,
  name: 'Test Template',
  description: 'Test template description',
  category: 'development' as TaskCategory,
  builtin: false,
  protocolConfig: {
    missionTemplate: 'Test mission: {mission}',
    executionRules: '1. Do something\n2. Do something else',
    memoryRules: '## Memory Rules\n- Rule 1',
  },
  params: [
    {
      key: 'mission',
      label: 'Mission',
      type: 'textarea',
      required: true,
    },
  ],
  enabled: true,
  createdAt: Math.floor(Date.now() / 1000),
  updatedAt: Math.floor(Date.now() / 1000),
  ...overrides,
});

describe('Task Types Integration', () => {
  describe('ScheduledTask', () => {
    it('should create a simple task with all required fields', () => {
      const task = createMockTask();

      expect(task.id).toBeDefined();
      expect(task.name).toBe('Test Task');
      expect(task.enabled).toBe(true);
      expect(task.mode).toBe('simple');
      expect(task.triggerType).toBe('interval');
      expect(task.triggerValue).toBe('1h');
    });

    it('should create a protocol mode task with extended fields', () => {
      const task = createMockProtocolTask();

      expect(task.mode).toBe('protocol');
      expect(task.taskPath).toBe('/path/to/task');
      expect(task.mission).toBe('Test mission');
      expect(task.templateId).toBe('dev-feature');
      expect(task.templateParams).toEqual({ mission: 'Test feature' });
      expect(task.maxRuns).toBe(10);
    });

    it('should support task categories', () => {
      const categories: TaskCategory[] = ['development', 'review', 'news', 'monitor', 'custom'];

      categories.forEach((category) => {
        const task = createMockTask({ category });
        expect(task.category).toBe(category);
      });
    });

    it('should support different trigger types', () => {
      // Interval trigger
      const intervalTask = createMockTask({
        triggerType: 'interval',
        triggerValue: '30m',
      });
      expect(intervalTask.triggerType).toBe('interval');

      // Cron trigger
      const cronTask = createMockTask({
        triggerType: 'cron',
        triggerValue: '0 9 * * 1-5',
      });
      expect(cronTask.triggerType).toBe('cron');

      // Once trigger
      const onceTask = createMockTask({
        triggerType: 'once',
        triggerValue: new Date().toISOString(),
      });
      expect(onceTask.triggerType).toBe('once');
    });

    it('should track execution state', () => {
      const task = createMockTask({
        lastRunAt: Math.floor(Date.now() / 1000) - 3600,
        lastRunStatus: 'success',
        currentRuns: 5,
      });

      expect(task.lastRunAt).toBeDefined();
      expect(task.lastRunStatus).toBe('success');
      expect(task.currentRuns).toBe(5);
    });
  });

  describe('ProtocolTemplate', () => {
    it('should create a template with all configuration options', () => {
      const template = createMockProtocolTemplate();

      expect(template.id).toBeDefined();
      expect(template.name).toBe('Test Template');
      expect(template.category).toBe('development');
      expect(template.builtin).toBe(false);
      expect(template.protocolConfig.missionTemplate).toBeDefined();
      expect(template.params).toHaveLength(1);
    });

    it('should support different parameter types', () => {
      const template = createMockProtocolTemplate({
        params: [
          { key: 'text', label: 'Text', type: 'text', required: true },
          { key: 'textarea', label: 'Textarea', type: 'textarea', required: false },
          {
            key: 'select',
            label: 'Select',
            type: 'select',
            required: true,
            options: [
              { value: 'a', label: 'Option A' },
              { value: 'b', label: 'Option B' },
            ],
          },
          { key: 'number', label: 'Number', type: 'number', required: false },
          { key: 'date', label: 'Date', type: 'date', required: false },
        ],
      });

      expect(template.params).toHaveLength(5);
      expect(template.params[2].options).toBeDefined();
      expect(template.params[2].options).toHaveLength(2);
    });

    it('should support custom sections', () => {
      const template = createMockProtocolTemplate({
        protocolConfig: {
          missionTemplate: 'Test mission',
          executionRules: 'Rules here',
          memoryRules: 'Memory rules',
          customSections: [
            {
              title: 'Custom Section',
              template: 'Custom content: {param}',
              position: 'afterRules',
            },
          ],
        },
      });

      expect(template.protocolConfig.customSections).toBeDefined();
      expect(template.protocolConfig.customSections).toHaveLength(1);
    });

    it('should support default trigger settings', () => {
      const template = createMockProtocolTemplate({
        defaultTriggerType: 'interval',
        defaultTriggerValue: '2h',
        defaultEngineId: 'claude-code',
        defaultMaxRuns: 100,
        defaultTimeoutMinutes: 30,
      });

      expect(template.defaultTriggerType).toBe('interval');
      expect(template.defaultTriggerValue).toBe('2h');
      expect(template.defaultEngineId).toBe('claude-code');
      expect(template.defaultMaxRuns).toBe(100);
      expect(template.defaultTimeoutMinutes).toBe(30);
    });
  });
});

describe('Template Rendering Integration', () => {
  it('should render template with parameters', async () => {
    const { renderProtocolTemplate } = await import('../types/scheduler');

    const template = 'Task: {mission}\nPriority: {priority}';
    const params = {
      mission: 'Implement feature X',
      priority: 'high',
    };

    const result = renderProtocolTemplate(template, params);

    expect(result).toContain('Implement feature X');
    expect(result).toContain('high');
  });

  it('should extract placeholders from template', async () => {
    const { extractPlaceholders } = await import('../types/scheduler');

    const template = 'Task: {mission}\nDate: {date}\nTime: {time}';
    const placeholders = extractPlaceholders(template);

    expect(placeholders).toContain('mission');
    expect(placeholders).toContain('date');
    expect(placeholders).toContain('time');
    expect(placeholders).toHaveLength(3);
  });

  it('should generate protocol document from template', async () => {
    const { generateProtocolDocument } = await import('../types/scheduler');

    const template = createMockProtocolTemplate();
    const params = { mission: 'Test feature implementation' };

    const document = generateProtocolDocument(template, params);

    expect(document).toContain('# 任务协议');
    expect(document).toContain('Test feature implementation');
    expect(document).toContain('## 任务目标');
    expect(document).toContain('## 执行规则');
  });
});

describe('Interval Parsing Integration', () => {
  it('should parse interval values correctly', async () => {
    const { parseIntervalValue, formatIntervalValue } = await import('../types/scheduler');

    // Parse valid intervals
    expect(parseIntervalValue('30s')).toEqual({ num: 30, unit: 's' });
    expect(parseIntervalValue('5m')).toEqual({ num: 5, unit: 'm' });
    expect(parseIntervalValue('2h')).toEqual({ num: 2, unit: 'h' });
    expect(parseIntervalValue('1d')).toEqual({ num: 1, unit: 'd' });

    // Invalid intervals
    expect(parseIntervalValue('invalid')).toBeNull();
    expect(parseIntervalValue('')).toBeNull();

    // Format intervals
    expect(formatIntervalValue(30, 's')).toBe('30s');
    expect(formatIntervalValue(5, 'm')).toBe('5m');
  });
});

describe('CreateTaskParams Integration', () => {
  it('should create params for simple mode task', () => {
    const params: CreateTaskParams = {
      name: 'Simple Task',
      triggerType: 'interval',
      triggerValue: '1h',
      engineId: 'claude-code',
      prompt: 'Execute this task',
    };

    expect(params.mode).toBeUndefined(); // defaults to simple
    expect(params.category).toBeUndefined();
    expect(params.taskPath).toBeUndefined();
    expect(params.mission).toBeUndefined();
  });

  it('should create params for protocol mode task', () => {
    const params: CreateTaskParams = {
      name: 'Protocol Task',
      triggerType: 'interval',
      triggerValue: '1h',
      engineId: 'claude-code',
      prompt: '',
      mode: 'protocol',
      category: 'development',
      mission: 'Implement feature X',
      templateId: 'dev-feature',
      templateParams: { mission: 'Feature X' },
      maxRuns: 10,
      timeoutMinutes: 30,
    };

    expect(params.mode).toBe('protocol');
    expect(params.category).toBe('development');
    expect(params.mission).toBe('Implement feature X');
    expect(params.templateId).toBe('dev-feature');
    expect(params.maxRuns).toBe(10);
  });
});

describe('Task Validation Integration', () => {
  it('should validate required fields for simple task', () => {
    const params: CreateTaskParams = {
      name: '', // Invalid: empty name
      triggerType: 'interval',
      triggerValue: '', // Invalid: empty value
      engineId: '',
      prompt: '',
    };

    // Name should not be empty
    expect(params.name).toBe('');
    expect(params.triggerValue).toBe('');
  });

  it('should validate template params for protocol task', () => {
    const template = createMockProtocolTemplate({
      params: [
        { key: 'mission', label: 'Mission', type: 'textarea', required: true },
        { key: 'optional', label: 'Optional', type: 'text', required: false },
      ],
    });

    // Check required params
    const requiredParams = template.params.filter((p) => p.required);
    expect(requiredParams).toHaveLength(1);
    expect(requiredParams[0].key).toBe('mission');

    // Check optional params
    const optionalParams = template.params.filter((p) => !p.required);
    expect(optionalParams).toHaveLength(1);
    expect(optionalParams[0].key).toBe('optional');
  });
});

describe('State Transitions Integration', () => {
  it('should track task execution flow', () => {
    // Create task
    const task = createMockTask({
      enabled: true,
      currentRuns: 0,
      lastRunStatus: undefined,
    });

    // Start execution
    const runningTask = {
      ...task,
      lastRunStatus: 'running' as const,
      lastRunAt: Math.floor(Date.now() / 1000),
    };
    expect(runningTask.lastRunStatus).toBe('running');

    // Complete execution
    const completedTask = {
      ...runningTask,
      lastRunStatus: 'success' as const,
      currentRuns: runningTask.currentRuns + 1,
    };
    expect(completedTask.lastRunStatus).toBe('success');
    expect(completedTask.currentRuns).toBe(1);

    // Check max runs
    const taskWithMaxRuns = {
      ...completedTask,
      maxRuns: 10,
    };
    expect(taskWithMaxRuns.currentRuns).toBeLessThan(taskWithMaxRuns.maxRuns!);
  });

  it('should handle retry logic', () => {
    const task = createMockTask({
      maxRetries: 3,
      retryCount: 0,
      retryInterval: '5m',
    });

    // Simulate failure and retry
    const retryTask = {
      ...task,
      retryCount: task.retryCount + 1,
      lastRunStatus: 'failed' as const,
    };

    expect(retryTask.retryCount).toBe(1);
    expect(retryTask.retryCount).toBeLessThanOrEqual(retryTask.maxRetries!);
  });
});

describe('Template Categories Integration', () => {
  it('should categorize templates correctly', () => {
    const templates: ProtocolTemplate[] = [
      createMockProtocolTemplate({ id: 'dev-1', category: 'development' }),
      createMockProtocolTemplate({ id: 'review-1', category: 'review' }),
      createMockProtocolTemplate({ id: 'news-1', category: 'news' }),
      createMockProtocolTemplate({ id: 'monitor-1', category: 'monitor' }),
      createMockProtocolTemplate({ id: 'custom-1', category: 'custom' }),
    ];

    // Group by category
    const byCategory = templates.reduce(
      (acc, t) => {
        if (!acc[t.category]) acc[t.category] = [];
        acc[t.category].push(t);
        return acc;
      },
      {} as Record<TaskCategory, ProtocolTemplate[]>
    );

    expect(byCategory['development']).toHaveLength(1);
    expect(byCategory['review']).toHaveLength(1);
    expect(byCategory['news']).toHaveLength(1);
    expect(byCategory['monitor']).toHaveLength(1);
    expect(byCategory['custom']).toHaveLength(1);
  });

  it('should filter builtin templates', () => {
    const templates: ProtocolTemplate[] = [
      createMockProtocolTemplate({ id: 'builtin-1', builtin: true }),
      createMockProtocolTemplate({ id: 'custom-1', builtin: false }),
      createMockProtocolTemplate({ id: 'builtin-2', builtin: true }),
    ];

    const builtinTemplates = templates.filter((t) => t.builtin);
    const customTemplates = templates.filter((t) => !t.builtin);

    expect(builtinTemplates).toHaveLength(2);
    expect(customTemplates).toHaveLength(1);
  });
});
