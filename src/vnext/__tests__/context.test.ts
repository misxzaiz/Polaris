/**
 * Scheduler vNext - Context Builder Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ContextBuilder,
  getContextBuilder,
  resetContextBuilder,
  createEmptyUserInput,
  generateContextId,
} from '../context';
import type { Workflow, WorkflowNode } from '../types/workflow';
import type { MemoryState } from '../types/memory';
import type { ExecutionRecord } from '../types/execution';

describe('Context Types', () => {
  describe('createEmptyUserInput', () => {
    it('should create user input with correct structure', () => {
      const input = createEmptyUserInput('interrupt', 'Test interrupt');

      expect(input.type).toBe('interrupt');
      expect(input.content).toBe('Test interrupt');
      expect(input.processed).toBe(false);
      expect(input.id).toMatch(/^input_\d+_[a-z0-9]+$/);
    });
  });

  describe('generateContextId', () => {
    it('should generate unique context IDs', () => {
      const id1 = generateContextId();
      const id2 = generateContextId();

      expect(id1).toMatch(/^ctx_\d+_[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
    });
  });
});

describe('ContextBuilder', () => {
  let builder: ContextBuilder;
  let mockWorkflow: Workflow;
  let mockNode: WorkflowNode;
  let mockMemory: MemoryState;

  beforeEach(() => {
    builder = new ContextBuilder();

    mockWorkflow = {
      id: 'workflow-1',
      name: 'Test Workflow',
      status: 'RUNNING',
      mode: 'continuous',
      currentRound: 1,
      memoryRoot: '/test/memory',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    mockNode = {
      id: 'node-1',
      workflowId: 'workflow-1',
      role: 'developer',
      state: 'READY',
      triggerType: 'start',
      priority: 1,
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    mockMemory = {
      active: ['Task 1 completed', 'Task 2 in progress'],
      summaries: [],
      archives: [],
      checkpoints: [],
      semantic: [],
      tasks: [],
      userInputs: [],
    };
  });

  describe('buildNodeContext', () => {
    it('should build basic node context', async () => {
      const context = await builder.buildNodeContext(mockWorkflow, mockNode);

      expect(context.workflow).toBe(mockWorkflow);
      expect(context.node).toBe(mockNode);
      expect(context.round).toBe(1);
      expect(context.workDir).toBe('/test/memory');
    });

    it('should include memory when enabled', async () => {
      builder.updateMemoryState(mockMemory);

      const context = await builder.buildNodeContext(mockWorkflow, mockNode, {
        includeMemory: true,
      });

      expect(context.memory.active).toEqual(mockMemory.active);
    });

    it('should exclude memory when disabled', async () => {
      builder.updateMemoryState(mockMemory);

      const context = await builder.buildNodeContext(mockWorkflow, mockNode, {
        includeMemory: false,
      });

      expect(context.memory.active).toHaveLength(0);
    });

    it('should include execution history', async () => {
      const record: ExecutionRecord = {
        id: 'exec-1',
        nodeId: 'node-1',
        workflowId: 'workflow-1',
        round: 1,
        status: 'SUCCESS',
        startedAt: Date.now() - 1000,
        finishedAt: Date.now(),
        toolCalls: [],
      };

      builder.addExecutionRecord('node-1', record);

      const context = await builder.buildNodeContext(mockWorkflow, mockNode, {
        includeHistory: true,
      });

      expect(context.executionHistory).toHaveLength(1);
      expect(context.executionHistory[0].id).toBe('exec-1');
    });

    it('should include user inputs', async () => {
      const input = createEmptyUserInput('supplement', 'Additional requirement');
      builder.addUserInput('node-1', input);

      const context = await builder.buildNodeContext(mockWorkflow, mockNode, {
        includeUserInputs: true,
      });

      expect(context.userInputs).toHaveLength(1);
      expect(context.userInputs[0].content).toBe('Additional requirement');
    });

    it('should limit history items', async () => {
      for (let i = 0; i < 20; i++) {
        builder.addExecutionRecord('node-1', {
          id: `exec-${i}`,
          nodeId: 'node-1',
          workflowId: 'workflow-1',
          round: i,
          status: 'SUCCESS',
          startedAt: Date.now(),
          toolCalls: [],
        });
      }

      const context = await builder.buildNodeContext(mockWorkflow, mockNode, {
        includeHistory: true,
        maxHistoryItems: 5,
      });

      expect(context.executionHistory.length).toBeLessThanOrEqual(5);
    });
  });

  describe('buildPromptContext', () => {
    it('should build system prompt', async () => {
      const nodeContext = await builder.buildNodeContext(mockWorkflow, mockNode);
      const promptContext = builder.buildPromptContext(nodeContext);

      expect(promptContext.systemPrompt).toContain('Test Workflow');
      expect(promptContext.systemPrompt).toContain('developer');
    });

    it('should build user prompt with memory', async () => {
      builder.updateMemoryState(mockMemory);
      mockNode.taskPrompt = 'Implement feature X';

      const nodeContext = await builder.buildNodeContext(mockWorkflow, mockNode);
      const promptContext = builder.buildPromptContext(nodeContext);

      expect(promptContext.userPrompt).toContain('Memory Summary');
      expect(promptContext.userPrompt).toContain('Current Task');
      expect(promptContext.userPrompt).toContain('Implement feature X');
    });

    it('should build context info', async () => {
      const nodeContext = await builder.buildNodeContext(mockWorkflow, mockNode);
      const promptContext = builder.buildPromptContext(nodeContext);

      expect(promptContext.contextInfo.workflowName).toBe('Test Workflow');
      expect(promptContext.contextInfo.nodeRole).toBe('developer');
      expect(promptContext.contextInfo.round).toBe(1);
    });

    it('should build template variables', async () => {
      const nodeContext = await builder.buildNodeContext(mockWorkflow, mockNode);
      const promptContext = builder.buildPromptContext(nodeContext, {
        customVars: { customVar: 'customValue' },
      });

      expect(promptContext.templateVars.workflowId).toBe('workflow-1');
      expect(promptContext.templateVars.nodeRole).toBe('developer');
      expect(promptContext.templateVars.customVar).toBe('customValue');
    });
  });

  describe('renderTemplate', () => {
    it('should replace simple variables', () => {
      const template = 'Hello, {{name}}!';
      const result = builder.renderTemplate(template, { name: 'World' });

      expect(result).toBe('Hello, World!');
    });

    it('should replace multiple variables', () => {
      const template = '{{greeting}}, {{name}}! Welcome to {{place}}.';
      const result = builder.renderTemplate(template, {
        greeting: 'Hello',
        name: 'Alice',
        place: 'Wonderland',
      });

      expect(result).toBe('Hello, Alice! Welcome to Wonderland.');
    });

    it('should handle missing variables', () => {
      const template = 'Hello, {{name}}!';
      const result = builder.renderTemplate(template, {});

      expect(result).toBe('Hello, !');
    });

    it('should handle conditional blocks', () => {
      const template = 'Value: {{#if show}}visible{{/if}}';

      const resultTrue = builder.renderTemplate(template, { show: true });
      expect(resultTrue).toBe('Value: visible');

      const resultFalse = builder.renderTemplate(template, { show: false });
      expect(resultFalse).toBe('Value:');
    });
  });

  describe('state management', () => {
    it('should update memory state', () => {
      const newMemory: MemoryState = {
        active: ['New task'],
        summaries: [],
        archives: [],
        checkpoints: [],
        semantic: [],
        tasks: [],
        userInputs: [],
      };

      builder.updateMemoryState(newMemory);

      // Verify through building context
      builder.buildNodeContext(mockWorkflow, mockNode, { includeMemory: true }).then(context => {
        expect(context.memory.active).toContain('New task');
      });
    });

    it('should mark input as processed', () => {
      const input = createEmptyUserInput('feedback', 'Good work');
      builder.addUserInput('node-1', input);

      builder.markInputProcessed('node-1', input.id);

      // Verify by getting unprocessed inputs
      builder.buildNodeContext(mockWorkflow, mockNode, { includeUserInputs: true }).then(context => {
        expect(context.userInputs).toHaveLength(0);
      });
    });
  });

  describe('with profile', () => {
    it('should include profile constraints in system prompt', async () => {
      const profile = {
        id: 'test-profile',
        name: 'Test Profile',
        role: 'developer',
        systemPolicy: 'You are a test agent.',
        executionStrategy: 'PLAN_FIRST' as const,
        scoringRule: { criteria: [], minScore: 0, autoRollback: false },
        doneDefinition: { conditions: [], requireConfirmation: false },
        memoryPolicy: {
          maxActiveLines: 1000,
          maxTokens: 50000,
          compactionThreshold: 5,
          autoArchive: true,
          retentionDays: 30,
          semanticIndex: false,
        },
        iterationPolicy: {
          maxIterations: 10,
          maxRounds: 50,
          iterationTimeoutMs: 300000,
          allowEarlyTermination: true,
          cooldownMs: 1000,
        },
        outputProtocol: {
          requiredFields: ['summary', 'changes'],
          format: 'markdown' as const,
          requireSummary: true,
          requireCommitMessage: false,
        },
        selfEvolve: false,
        constraints: [
          { type: 'forbidden' as const, description: 'No deletion', rule: 'delete_*', severity: 'error' as const },
        ],
        requiredTools: ['read', 'write'],
        tags: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      builder.registerProfile(profile);
      mockNode.templateId = 'test-profile';

      const nodeContext = await builder.buildNodeContext(mockWorkflow, mockNode);
      const promptContext = builder.buildPromptContext(nodeContext);

      expect(promptContext.systemPrompt).toContain('You are a test agent.');
      expect(promptContext.systemPrompt).toContain('Constraints');
      expect(promptContext.systemPrompt).toContain('Required Output Fields');
    });
  });
});

describe('Global ContextBuilder', () => {
  beforeEach(() => {
    resetContextBuilder();
  });

  describe('getContextBuilder', () => {
    it('should return singleton instance', () => {
      const b1 = getContextBuilder();
      const b2 = getContextBuilder();

      expect(b1).toBe(b2);
    });
  });

  describe('resetContextBuilder', () => {
    it('should reset singleton instance', () => {
      const b1 = getContextBuilder();
      resetContextBuilder();
      const b2 = getContextBuilder();

      expect(b1).not.toBe(b2);
    });
  });
});
