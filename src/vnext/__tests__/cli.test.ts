/**
 * CLI Tool Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CLITool,
  createCLITool,
  formatTable,
  formatJSON,
  formatYAML,
  formatStatusBadge,
  formatDuration,
  formatRelativeTime,
} from '../cli';
import { WorkflowRuntime } from '../runtime';
import { getWorkflowPersistence, resetWorkflowPersistence } from '../persistence';
import type { Workflow } from '../types';
import type { CLIOptions, MonitorData, TableColumn } from '../cli/types';

describe('CLI Formatters', () => {
  describe('formatTable', () => {
    it('should format simple table', () => {
      const data = [
        { id: '1', name: 'Test 1', status: 'active' },
        { id: '2', name: 'Test 2', status: 'inactive' },
      ];

      const result = formatTable(data, {
        columns: [
          { header: 'ID', property: 'id' },
          { header: 'Name', property: 'name' },
          { header: 'Status', property: 'status' },
        ],
      });

      expect(result).toContain('ID');
      expect(result).toContain('Name');
      expect(result).toContain('Test 1');
      expect(result).toContain('Test 2');
    });

    it('should handle empty data', () => {
      const result = formatTable([], {
        columns: [{ header: 'ID', property: 'id' }],
      });
      expect(result).toBe('No data');
    });

    it('should format with borders', () => {
      const data = [{ id: '1', name: 'Test' }];

      const result = formatTable(data, {
        columns: [
          { header: 'ID', property: 'id' },
          { header: 'Name', property: 'name' },
        ],
        showBorders: true,
      });

      expect(result).toContain('+');
      expect(result).toContain('|');
      expect(result).toContain('-');
    });

    it('should format without borders', () => {
      const data = [{ id: '1', name: 'Test' }];

      const result = formatTable(data, {
        columns: [
          { header: 'ID', property: 'id' },
          { header: 'Name', property: 'name' },
        ],
        showBorders: false,
      });

      expect(result).not.toContain('+');
      expect(result).toContain('ID');
      expect(result).toContain('Test');
    });

    it('should apply custom format', () => {
      const data = [{ id: '1', count: 1000 }];

      const result = formatTable(data, {
        columns: [
          { header: 'ID', property: 'id' },
          { header: 'Count', property: 'count', format: (v) => `${v} items` },
        ],
      });

      expect(result).toContain('1000 items');
    });

    it('should handle alignment', () => {
      const data = [{ left: 'left', center: 'center', right: 'right' }];

      const result = formatTable(data, {
        columns: [
          { header: 'Left', property: 'left', align: 'left' },
          { header: 'Center', property: 'center', align: 'center' },
          { header: 'Right', property: 'right', align: 'right' },
        ],
      });

      expect(result).toContain('left');
      expect(result).toContain('center');
      expect(result).toContain('right');
    });
  });

  describe('formatJSON', () => {
    it('should format JSON with pretty print', () => {
      const data = { id: '1', name: 'Test' };
      const result = formatJSON(data, true);

      expect(result).toContain('{\n');
      expect(result).toContain('"id"');
      expect(result).toContain('"name"');
    });

    it('should format JSON without pretty print', () => {
      const data = { id: '1', name: 'Test' };
      const result = formatJSON(data, false);

      expect(result).not.toContain('\n');
      expect(result).toBe('{"id":"1","name":"Test"}');
    });

    it('should handle arrays', () => {
      const data = [1, 2, 3];
      const result = formatJSON(data);

      expect(JSON.parse(result)).toEqual([1, 2, 3]);
    });
  });

  describe('formatYAML', () => {
    it('should format primitive values', () => {
      expect(formatYAML(null)).toBe('null');
      expect(formatYAML(undefined)).toBe('null');
      expect(formatYAML('test')).toBe('test');
      expect(formatYAML(42)).toBe('42');
      expect(formatYAML(true)).toBe('true');
    });

    it('should format arrays', () => {
      const result = formatYAML([1, 2, 3]);
      expect(result).toContain('- 1');
      expect(result).toContain('- 2');
      expect(result).toContain('- 3');
    });

    it('should format objects', () => {
      const result = formatYAML({ id: '1', name: 'Test' });
      expect(result).toContain('id: 1');
      expect(result).toContain('name: Test');
    });

    it('should handle empty arrays', () => {
      expect(formatYAML([])).toBe('[]');
    });

    it('should handle empty objects', () => {
      expect(formatYAML({})).toBe('{}');
    });
  });

  describe('formatStatusBadge', () => {
    it('should format status badges', () => {
      expect(formatStatusBadge('CREATED')).toBe('[CREATED]');
      expect(formatStatusBadge('RUNNING')).toBe('[RUNNING]');
      expect(formatStatusBadge('WAITING_EVENT')).toBe('[WAITING]');
      expect(formatStatusBadge('COMPLETED')).toBe('[COMPLETED]');
      expect(formatStatusBadge('FAILED')).toBe('[FAILED]');
      expect(formatStatusBadge('EVOLVING')).toBe('[EVOLVING]');
    });
  });

  describe('formatDuration', () => {
    it('should format milliseconds', () => {
      expect(formatDuration(100)).toBe('100ms');
      expect(formatDuration(999)).toBe('999ms');
    });

    it('should format seconds', () => {
      expect(formatDuration(1000)).toBe('1.0s');
      expect(formatDuration(5000)).toBe('5.0s');
    });

    it('should format minutes', () => {
      expect(formatDuration(60000)).toBe('1.0m');
      expect(formatDuration(120000)).toBe('2.0m');
    });

    it('should format hours', () => {
      expect(formatDuration(3600000)).toBe('1.0h');
      expect(formatDuration(7200000)).toBe('2.0h');
    });
  });

  describe('formatRelativeTime', () => {
    it('should format "just now" for recent times', () => {
      const now = Date.now();
      expect(formatRelativeTime(now)).toBe('just now');
      expect(formatRelativeTime(now - 30000)).toBe('just now');
    });

    it('should format minutes ago', () => {
      const now = Date.now();
      expect(formatRelativeTime(now - 60000)).toBe('1m ago');
      expect(formatRelativeTime(now - 120000)).toBe('2m ago');
    });

    it('should format hours ago', () => {
      const now = Date.now();
      expect(formatRelativeTime(now - 3600000)).toBe('1h ago');
      expect(formatRelativeTime(now - 7200000)).toBe('2h ago');
    });

    it('should format days ago', () => {
      const now = Date.now();
      expect(formatRelativeTime(now - 86400000)).toBe('1d ago');
      expect(formatRelativeTime(now - 172800000)).toBe('2d ago');
    });
  });
});

describe('CLITool', () => {
  let cli: CLITool;
  let runtime: WorkflowRuntime;
  let persistence: ReturnType<typeof getWorkflowPersistence>;

  const testWorkflow: Workflow = {
    id: 'test-workflow',
    name: 'Test Workflow',
    description: 'A test workflow',
    status: 'CREATED',
    priority: 5,
    mode: 'continuous',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    currentRounds: 0,
    maxRounds: 100,
    tags: [],
  };

  const testNodes: WorkflowNode[] = [
    {
      id: 'node-1',
      workflowId: 'test-workflow',
      name: 'Node 1',
      role: 'agent',
      enabled: true,
      state: 'IDLE',
      triggerType: 'dependency',
      subscribeEvents: [],
      emitEvents: [],
      dependencies: [],
      nextNodes: [],
      maxRounds: 10,
      currentRounds: 0,
    },
  ];

  const registerTestWorkflow = () => {
    persistence.registerWorkflow(testWorkflow, testNodes);
  };

  beforeEach(() => {
    resetWorkflowPersistence();
    runtime = new WorkflowRuntime({ enableMonitoring: false, enablePersistence: false });
    persistence = getWorkflowPersistence();
    cli = createCLITool(runtime);
  });

  afterEach(() => {
    resetWorkflowPersistence();
  });

  describe('createCommand', () => {
    it('should create workflow with name', async () => {
      const result = await cli.execute('create', { name: 'New Workflow' });

      expect(result.success).toBe(true);
      expect(result.message).toContain('Workflow created');
      expect(result.data).toBeDefined();
    });

    it('should fail without name', async () => {
      const result = await cli.execute('create', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('name is required');
    });

    it('should create workflow from template', async () => {
      const result = await cli.execute('create', {
        name: 'Dev Workflow',
        template: 'dev-pipeline',
      });

      expect(result.success).toBe(true);
      const data = result.data as { workflow: Workflow; nodes: WorkflowNode[] };
      expect(data.nodes.length).toBeGreaterThan(0);
    });

    it('should fail with invalid template', async () => {
      const result = await cli.execute('create', {
        name: 'Test',
        template: 'invalid-template',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Template not found');
    });
  });

  describe('listCommand', () => {
    it('should list empty workflows', async () => {
      const result = await cli.execute('list', {});

      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });

    it('should list workflows', async () => {
      registerTestWorkflow();

      const result = await cli.execute('list', {});

      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data).toHaveLength(1);
    });

    it('should format as JSON', async () => {
      registerTestWorkflow();

      const result = await cli.execute('list', { format: 'json' });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });
  });

  describe('showCommand', () => {
    it('should show workflow details', async () => {
      registerTestWorkflow();

      const result = await cli.execute('show', { id: 'test-workflow' });

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('workflow');
      expect(result.data).toHaveProperty('nodes');
      expect((result.data as { workflow: Workflow }).workflow.id).toBe('test-workflow');
    });

    it('should fail without id', async () => {
      const result = await cli.execute('show', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('ID is required');
    });

    it('should fail with non-existent workflow', async () => {
      const result = await cli.execute('show', { id: 'non-existent' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('startCommand', () => {
    it('should fail without id', async () => {
      const result = await cli.execute('start', {});

      expect(result.success).toBe(false);
    });

    it('should fail with non-existent workflow', async () => {
      const result = await cli.execute('start', { id: 'non-existent' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('pauseCommand', () => {
    it('should fail when no workflow running', async () => {
      const result = await cli.execute('pause', {});

      expect(result.success).toBe(false);
    });
  });

  describe('resumeCommand', () => {
    it('should fail when no workflow paused', async () => {
      const result = await cli.execute('resume', {});

      expect(result.success).toBe(false);
    });
  });

  describe('stopCommand', () => {
    it('should fail when no workflow running', async () => {
      const result = await cli.execute('stop', {});

      expect(result.success).toBe(false);
    });
  });

  describe('deleteCommand', () => {
    it('should delete workflow', async () => {
      registerTestWorkflow();

      const result = await cli.execute('delete', { id: 'test-workflow' });

      expect(result.success).toBe(true);
      expect(result.message).toContain('deleted');
    });

    it('should fail without id', async () => {
      const result = await cli.execute('delete', {});

      expect(result.success).toBe(false);
    });
  });

  describe('runCommand', () => {
    it('should create workflow', async () => {
      // Note: run command creates workflow and tries to start it
      // But without node executors, start may fail or timeout
      const result = await cli.execute('run', { name: 'Quick Run' });

      // At minimum, workflow should be created
      expect(result.data).toBeDefined();
    });
  });

  describe('statusCommand', () => {
    it('should get workflow status', async () => {
      registerTestWorkflow();

      const result = await cli.execute('status', { id: 'test-workflow' });

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('id', 'test-workflow');
      expect(result.data).toHaveProperty('status');
      expect(result.data).toHaveProperty('nodes');
    });
  });

  describe('monitorCommand', () => {
    it('should return monitor data', async () => {
      registerTestWorkflow();

      const result = await cli.execute('monitor', {});

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('timestamp');
      expect(result.data).toHaveProperty('activeWorkflows');
      expect(result.data).toHaveProperty('workflows');
    });
  });

  describe('templateCommand', () => {
    it('should list templates', async () => {
      const result = await cli.execute('template', {});

      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data.length).toBeGreaterThan(0);
    });

    it('should include builtin templates', async () => {
      const result = await cli.execute('template', {});

      const templates = result.data as Array<{ id: string }>;
      expect(templates.find((t) => t.id === 'dev-pipeline')).toBeDefined();
      expect(templates.find((t) => t.id === 'feature-flow')).toBeDefined();
      expect(templates.find((t) => t.id === 'test-suite')).toBeDefined();
    });
  });

  describe('helpCommand', () => {
    it('should show help', async () => {
      const result = await cli.execute('help', {});

      expect(result.success).toBe(true);
      expect(result.message).toContain('Polaris Scheduler');
      expect(result.message).toContain('Commands:');
    });
  });

  describe('versionCommand', () => {
    it('should show version', async () => {
      const result = await cli.execute('version', {});

      expect(result.success).toBe(true);
      expect(result.message).toContain('v1.0.0');
    });
  });

  describe('unknownCommand', () => {
    it('should fail for unknown command', async () => {
      // @ts-expect-error Testing unknown command
      const result = await cli.execute('unknown', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown command');
    });
  });

  describe('history', () => {
    it('should record command history', async () => {
      await cli.execute('version', {});
      await cli.execute('help', {});

      const history = cli.getHistory();
      expect(history.length).toBe(2);
      expect(history[0].command).toBe('version');
      expect(history[1].command).toBe('help');
    });
  });

  describe('getters', () => {
    it('should return runtime', () => {
      expect(cli.getRuntime()).toBe(runtime);
    });

    it('should return config', () => {
      const config = cli.getConfig();
      expect(config.defaultFormat).toBe('table');
      expect(config.defaultPriority).toBe('normal');
    });

    it('should return commands', () => {
      const commands = cli.getCommands();
      expect(commands.length).toBeGreaterThan(0);
      expect(commands.find((c) => c.name === 'create')).toBeDefined();
    });
  });
});
