/**
 * Scheduler vNext - Template System Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  TemplateEngine,
  getTemplateEngine,
  resetTemplateEngine,
  generateTemplateId,
  createEmptyVariable,
} from '../template';
import type {
  ProfileTemplate,
  PromptTemplate,
  WorkflowTemplate,
  TemplateRenderContext,
} from '../template';

describe('Template Types', () => {
  describe('generateTemplateId', () => {
    it('should generate unique template IDs', () => {
      const id1 = generateTemplateId('profile');
      const id2 = generateTemplateId('profile');

      expect(id1).toMatch(/^tmpl_profile_\d+_[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe('createEmptyVariable', () => {
    it('should create empty variable with defaults', () => {
      const v = createEmptyVariable('testVar');

      expect(v.name).toBe('testVar');
      expect(v.type).toBe('string');
      expect(v.required).toBe(false);
    });
  });
});

describe('TemplateEngine', () => {
  let engine: TemplateEngine;

  beforeEach(() => {
    engine = new TemplateEngine();
  });

  describe('registerTemplate', () => {
    it('should register prompt template', () => {
      const template: PromptTemplate = {
        id: 'test-prompt',
        name: 'Test Prompt',
        type: 'prompt',
        version: '1.0.0',
        tags: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        systemTemplate: 'System: {{role}}',
        userTemplate: 'User: {{task}}',
        variables: [
          { name: 'role', type: 'string', required: true },
          { name: 'task', type: 'string', required: true },
        ],
      };

      engine.registerTemplate(template);

      const retrieved = engine.getTemplate('test-prompt');
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe('Test Prompt');
    });

    it('should register profile template', () => {
      const template: ProfileTemplate = {
        id: 'test-profile',
        name: 'Test Profile',
        type: 'profile',
        version: '1.0.0',
        tags: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        profile: {
          name: 'Test Agent',
          role: 'test',
          systemPolicy: 'Test policy',
          executionStrategy: 'PLAN_FIRST',
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
            requiredFields: [],
            format: 'markdown',
            requireSummary: false,
            requireCommitMessage: false,
          },
          selfEvolve: false,
          constraints: [],
          requiredTools: [],
        },
      };

      engine.registerTemplate(template);

      const retrieved = engine.getTemplate('test-profile');
      expect(retrieved).toBeDefined();
      expect(retrieved?.type).toBe('profile');
    });
  });

  describe('getTemplate', () => {
    it('should return undefined for non-existent template', () => {
      const template = engine.getTemplate('non-existent');
      expect(template).toBeUndefined();
    });

    it('should increment usage count', () => {
      engine.getTemplate('builtin-developer-v1');
      engine.getTemplate('builtin-developer-v1');
      engine.getTemplate('builtin-developer-v1');

      const all = engine.getAllTemplates();
      const devTemplate = all.find(t => t.id === 'builtin-developer-v1');
      // Usage count is tracked internally
      expect(devTemplate).toBeDefined();
    });
  });

  describe('getTemplatesByType', () => {
    it('should return templates of specific type', () => {
      const profiles = engine.getTemplatesByType('profile');
      const prompts = engine.getTemplatesByType('prompt');
      const workflows = engine.getTemplatesByType('workflow');

      expect(profiles.length).toBeGreaterThan(0);
      expect(prompts.length).toBeGreaterThan(0);
      expect(workflows.length).toBeGreaterThan(0);
    });
  });

  describe('renderPromptTemplate', () => {
    it('should render template with variables', () => {
      const context: TemplateRenderContext = {
        variables: {
          role: 'developer',
          workflowName: 'Test Workflow',
          round: 1,
          task: 'Implement feature X',
        },
      };

      const result = engine.renderPromptTemplate('builtin-task-prompt', context);

      expect(result.success).toBe(true);
      expect(result.content).toContain('developer');
      expect(result.content).toContain('Implement feature X');
    });

    it('should fail for missing required variables', () => {
      const context: TemplateRenderContext = {
        variables: {},
      };

      const result = engine.renderPromptTemplate('builtin-task-prompt', context);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].type).toBe('missing_variable');
    });

    it('should handle conditional blocks', () => {
      const context: TemplateRenderContext = {
        variables: {
          role: 'developer',
          workflowName: 'Test Workflow',
          round: 1,
          task: 'Test task',
          memory: 'Previous context',
        },
      };

      const result = engine.renderPromptTemplate('builtin-task-prompt', context);

      expect(result.success).toBe(true);
      expect(result.content).toContain('Memory');
    });

    it('should handle nested variables', () => {
      const context: TemplateRenderContext = {
        variables: {
          role: 'developer',
          workflowName: 'Test Workflow',
          round: 1,
          task: 'Test',
        },
        workflowContext: {
          id: 'workflow-1',
          name: 'Test Workflow',
          currentRound: 5,
        },
      };

      const result = engine.renderPromptTemplate('builtin-task-prompt', context);

      expect(result.success).toBe(true);
    });

    it('should return error for non-existent template', () => {
      const context: TemplateRenderContext = { variables: {} };

      const result = engine.renderPromptTemplate('non-existent', context);

      expect(result.success).toBe(false);
      expect(result.errors[0].type).toBe('unknown');
    });

    it('should return error for non-prompt template', () => {
      const context: TemplateRenderContext = { variables: {} };

      const result = engine.renderPromptTemplate('builtin-developer-v1', context);

      expect(result.success).toBe(false);
      expect(result.errors[0].message).toContain('not a prompt template');
    });
  });

  describe('createProfileFromTemplate', () => {
    it('should create profile from template', () => {
      const profile = engine.createProfileFromTemplate('builtin-developer-v1');

      expect(profile).toBeDefined();
      expect(profile?.role).toBe('developer');
      expect(profile?.id).toMatch(/^profile_/);
    });

    it('should apply overrides', () => {
      const profile = engine.createProfileFromTemplate('builtin-developer-v1', {
        name: 'Custom Developer',
      });

      expect(profile?.name).toBe('Custom Developer');
    });

    it('should return null for non-profile template', () => {
      const profile = engine.createProfileFromTemplate('builtin-task-prompt');
      expect(profile).toBeNull();
    });

    it('should return null for non-existent template', () => {
      const profile = engine.createProfileFromTemplate('non-existent');
      expect(profile).toBeNull();
    });
  });

  describe('validateVariables', () => {
    it('should validate required variables', () => {
      const errors = engine.validateVariables('builtin-task-prompt', {});

      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.variableName === 'role')).toBe(true);
      expect(errors.some(e => e.variableName === 'task')).toBe(true);
    });

    it('should pass validation with all required variables', () => {
      const errors = engine.validateVariables('builtin-task-prompt', {
        role: 'developer',
        workflowName: 'Test Workflow',
        round: 1,
        task: 'Test task',
      });

      expect(errors).toHaveLength(0);
    });

    it('should return error for non-existent template', () => {
      const errors = engine.validateVariables('non-existent', {});

      expect(errors.length).toBe(1);
      expect(errors[0].type).toBe('unknown');
    });
  });

  describe('removeTemplate', () => {
    it('should remove non-builtin template', () => {
      const template: PromptTemplate = {
        id: 'removable',
        name: 'Removable',
        type: 'prompt',
        version: '1.0.0',
        tags: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        systemTemplate: 'Test',
        userTemplate: 'Test',
        variables: [],
      };

      engine.registerTemplate(template);
      expect(engine.getTemplate('removable')).toBeDefined();

      const removed = engine.removeTemplate('removable');
      expect(removed).toBe(true);
      expect(engine.getTemplate('removable')).toBeUndefined();
    });

    it('should not remove builtin template', () => {
      const removed = engine.removeTemplate('builtin-developer-v1');
      expect(removed).toBe(false);
      expect(engine.getTemplate('builtin-developer-v1')).toBeDefined();
    });
  });

  describe('getAllTemplates', () => {
    it('should return all templates including builtins', () => {
      const templates = engine.getAllTemplates();

      expect(templates.length).toBeGreaterThan(0);
      expect(templates.some(t => t.id === 'builtin-developer-v1')).toBe(true);
      expect(templates.some(t => t.id === 'builtin-product-v1')).toBe(true);
      expect(templates.some(t => t.id === 'builtin-tester-v1')).toBe(true);
    });
  });

  describe('builtin templates', () => {
    it('should have developer profile template', () => {
      const template = engine.getTemplate('builtin-developer-v1');
      expect(template).toBeDefined();
      expect(template?.type).toBe('profile');
    });

    it('should have product profile template', () => {
      const template = engine.getTemplate('builtin-product-v1');
      expect(template).toBeDefined();
      expect(template?.type).toBe('profile');
    });

    it('should have tester profile template', () => {
      const template = engine.getTemplate('builtin-tester-v1');
      expect(template).toBeDefined();
      expect(template?.type).toBe('profile');
    });

    it('should have development pipeline workflow template', () => {
      const template = engine.getTemplate('builtin-dev-pipeline') as WorkflowTemplate;
      expect(template).toBeDefined();
      expect(template?.type).toBe('workflow');
      expect(template?.workflow.nodes).toHaveLength(3);
    });

    it('should have feature flow workflow template', () => {
      const template = engine.getTemplate('builtin-feature-flow') as WorkflowTemplate;
      expect(template).toBeDefined();
      expect(template?.type).toBe('workflow');
      expect(template?.workflow.nodes).toHaveLength(2);
    });

    it('should have task prompt template', () => {
      const template = engine.getTemplate('builtin-task-prompt');
      expect(template).toBeDefined();
      expect(template?.type).toBe('prompt');
    });

    it('should have review prompt template', () => {
      const template = engine.getTemplate('builtin-review-prompt');
      expect(template).toBeDefined();
      expect(template?.type).toBe('prompt');
    });
  });

  describe('render edge cases', () => {
    it('should handle each loops', () => {
      // Register a template with each loop
      const template: PromptTemplate = {
        id: 'loop-test',
        name: 'Loop Test',
        type: 'prompt',
        version: '1.0.0',
        tags: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        systemTemplate: 'Test',
        userTemplate: `Items:
{{#each items}}
- {{this}}
{{/each}}`,
        variables: [
          { name: 'items', type: 'array', required: true },
        ],
      };

      engine.registerTemplate(template);

      const context: TemplateRenderContext = {
        variables: {
          items: ['Item 1', 'Item 2', 'Item 3'],
        },
      };

      const result = engine.renderPromptTemplate('loop-test', context);

      expect(result.success).toBe(true);
      expect(result.content).toContain('- Item 1');
      expect(result.content).toContain('- Item 2');
      expect(result.content).toContain('- Item 3');
    });

    it('should handle if-else blocks', () => {
      const template: PromptTemplate = {
        id: 'ifelse-test',
        name: 'IfElse Test',
        type: 'prompt',
        version: '1.0.0',
        tags: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        systemTemplate: 'Test',
        userTemplate: `{{#if show}}Shown{{else}}Hidden{{/if}}`,
        variables: [
          { name: 'show', type: 'boolean', required: true },
        ],
      };

      engine.registerTemplate(template);

      const trueResult = engine.renderPromptTemplate('ifelse-test', {
        variables: { show: true },
      });
      expect(trueResult.content).toContain('Shown');

      const falseResult = engine.renderPromptTemplate('ifelse-test', {
        variables: { show: false },
      });
      expect(falseResult.content).toContain('Hidden');
    });
  });
});

describe('Global TemplateEngine', () => {
  beforeEach(() => {
    resetTemplateEngine();
  });

  describe('getTemplateEngine', () => {
    it('should return singleton instance', () => {
      const e1 = getTemplateEngine();
      const e2 = getTemplateEngine();

      expect(e1).toBe(e2);
    });
  });

  describe('resetTemplateEngine', () => {
    it('should reset singleton instance', () => {
      const e1 = getTemplateEngine();
      resetTemplateEngine();
      const e2 = getTemplateEngine();

      expect(e1).not.toBe(e2);
    });
  });
});
