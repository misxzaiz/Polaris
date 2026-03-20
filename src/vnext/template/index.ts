/**
 * Scheduler vNext - Template System
 *
 * 模板系统实现
 */

import type { AgentProfile } from '../types/profile';
import type {
  TemplateBase,
  TemplateType,
  ProfileTemplate,
  PromptTemplate,
  WorkflowTemplate,
  NodeTemplate,
  TemplateVariable,
  TemplateRegistryEntry,
  TemplateRenderContext,
  TemplateRenderResult,
  TemplateError,
} from './types';

// ============================================================================
// Template Engine Interface
// ============================================================================

/**
 * 模板引擎接口
 */
export interface ITemplateEngine {
  /** 注册模板 */
  registerTemplate(template: ProfileTemplate | PromptTemplate | WorkflowTemplate | NodeTemplate): void;

  /** 获取模板 */
  getTemplate(id: string): ProfileTemplate | PromptTemplate | WorkflowTemplate | NodeTemplate | undefined;

  /** 按类型获取模板 */
  getTemplatesByType(type: TemplateType): (ProfileTemplate | PromptTemplate | WorkflowTemplate | NodeTemplate)[];

  /** 渲染提示词模板 */
  renderPromptTemplate(
    templateId: string,
    context: TemplateRenderContext
  ): TemplateRenderResult;

  /** 从模板创建 Profile */
  createProfileFromTemplate(templateId: string, overrides?: Partial<AgentProfile>): AgentProfile | null;

  /** 验证模板变量 */
  validateVariables(
    templateId: string,
    variables: Record<string, unknown>
  ): TemplateError[];

  /** 删除模板 */
  removeTemplate(id: string): boolean;

  /** 获取所有模板 */
  getAllTemplates(): (ProfileTemplate | PromptTemplate | WorkflowTemplate | NodeTemplate)[];
}

// ============================================================================
// Template Engine Implementation
// ============================================================================

/**
 * 模板引擎实现
 */
export class TemplateEngine implements ITemplateEngine {
  private registry: Map<string, TemplateRegistryEntry> = new Map();

  constructor() {
    this.initializeBuiltins();
  }

  // --------------------------------------------------------------------------
  // Public Methods
  // --------------------------------------------------------------------------

  registerTemplate(
    template: ProfileTemplate | PromptTemplate | WorkflowTemplate | NodeTemplate
  ): void {
    this.registry.set(template.id, {
      template,
      builtin: false,
      usageCount: 0,
    });
  }

  getTemplate(
    id: string
  ): ProfileTemplate | PromptTemplate | WorkflowTemplate | NodeTemplate | undefined {
    const entry = this.registry.get(id);
    if (entry) {
      entry.usageCount++;
      entry.lastUsedAt = Date.now();
      return entry.template;
    }
    return undefined;
  }

  getTemplatesByType(
    type: TemplateType
  ): (ProfileTemplate | PromptTemplate | WorkflowTemplate | NodeTemplate)[] {
    return Array.from(this.registry.values())
      .filter(entry => entry.template.type === type)
      .map(entry => entry.template);
  }

  renderPromptTemplate(
    templateId: string,
    context: TemplateRenderContext
  ): TemplateRenderResult {
    const errors: TemplateError[] = [];
    const warnings: string[] = [];
    const usedVariables: string[] = [];

    const template = this.getTemplate(templateId);
    if (!template) {
      errors.push({
        type: 'unknown',
        message: `Template not found: ${templateId}`,
      });
      return { success: false, content: '', usedVariables, errors, warnings };
    }

    if (template.type !== 'prompt') {
      errors.push({
        type: 'unknown',
        message: `Template ${templateId} is not a prompt template`,
      });
      return { success: false, content: '', usedVariables, errors, warnings };
    }

    const promptTemplate = template as PromptTemplate;

    // 验证必填变量
    const validationErrors = this.validateVariables(templateId, context.variables);
    errors.push(...validationErrors);

    if (errors.length > 0) {
      return { success: false, content: '', usedVariables, errors, warnings };
    }

    // 渲染系统提示词
    let systemPrompt = this.renderString(promptTemplate.systemTemplate, context, usedVariables, warnings);

    // 渲染用户提示词
    let userPrompt = this.renderString(promptTemplate.userTemplate, context, usedVariables, warnings);

    // 组合最终内容
    const content = this.combinePrompts(systemPrompt, userPrompt);

    return { success: true, content, usedVariables, errors, warnings };
  }

  createProfileFromTemplate(
    templateId: string,
    overrides?: Partial<AgentProfile>
  ): AgentProfile | null {
    const template = this.getTemplate(templateId);
    if (!template || template.type !== 'profile') {
      return null;
    }

    const profileTemplate = template as ProfileTemplate;
    const now = Date.now();

    const profile: AgentProfile = {
      ...profileTemplate.profile,
      id: overrides?.id || `profile_${Date.now()}`,
      createdAt: overrides?.createdAt || now,
      updatedAt: now,
      ...overrides,
    };

    return profile;
  }

  validateVariables(
    templateId: string,
    variables: Record<string, unknown>
  ): TemplateError[] {
    const errors: TemplateError[] = [];
    const template = this.registry.get(templateId);

    if (!template) {
      errors.push({
        type: 'unknown',
        message: `Template not found: ${templateId}`,
      });
      return errors;
    }

    if (template.template.type !== 'prompt') {
      return errors;
    }

    const promptTemplate = template.template as PromptTemplate;

    // 检查必填变量
    promptTemplate.variables.forEach(v => {
      if (v.required && variables[v.name] === undefined) {
        errors.push({
          type: 'missing_variable',
          message: `Required variable "${v.name}" is missing`,
          variableName: v.name,
        });
      }
    });

    return errors;
  }

  removeTemplate(id: string): boolean {
    const entry = this.registry.get(id);
    if (entry?.builtin) {
      return false; // 不允许删除内置模板
    }
    return this.registry.delete(id);
  }

  getAllTemplates(): (ProfileTemplate | PromptTemplate | WorkflowTemplate | NodeTemplate)[] {
    return Array.from(this.registry.values()).map(entry => entry.template);
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private renderString(
    template: string,
    context: TemplateRenderContext,
    usedVariables: string[],
    warnings: string[]
  ): string {
    let result = template;

    // 1. 先处理 each 循环 {{#each items}}...{{/each}}
    result = result.replace(
      /\{\{#each\s+(\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g,
      (_, varName, itemTemplate) => {
        const items = context.variables[varName];
        if (Array.isArray(items)) {
          if (!usedVariables.includes(varName)) {
            usedVariables.push(varName);
          }
          return items
            .map((item, index) => {
              let itemResult = itemTemplate;
              itemResult = itemResult.replace(/\{\{this\}\}/g, String(item));
              itemResult = itemResult.replace(/\{\{@index\}\}/g, String(index));
              return itemResult.trim();
            })
            .join('\n');
        }
        return '';
      }
    );

    // 2. 处理条件块 (带 else) {{#if variable}}...{{else}}...{{/if}} - 必须在简单 if 之前
    result = result.replace(
      /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{else\}\}([\s\S]*?)\{\{\/if\}\}/g,
      (_, varName, trueContent, falseContent) => {
        const value = context.variables[varName];
        if (!usedVariables.includes(varName)) {
          usedVariables.push(varName);
        }
        return value ? trueContent.trim() : falseContent.trim();
      }
    );

    // 3. 处理简单条件块 {{#if variable}}...{{/if}}
    result = result.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, varName, content) => {
      const value = context.variables[varName];
      if (!usedVariables.includes(varName)) {
        usedVariables.push(varName);
      }
      return value ? content.trim() : '';
    });

    // 4. 替换简单变量 {{variable}} - 必须在嵌套变量之前
    result = result.replace(/\{\{(\w+)\}\}/g, (_, varName) => {
      const value = context.variables[varName];
      if (value !== undefined) {
        if (!usedVariables.includes(varName)) {
          usedVariables.push(varName);
        }
        return String(value);
      }
      warnings.push(`Variable "${varName}" not found, using empty string`);
      return '';
    });

    // 5. 替换嵌套变量 {{context.workflow.name}} - 使用点号分隔的路径
    result = result.replace(/\{\{(\w+\.\w+(?:\.\w+)*)\}\}/g, (_, path) => {
      const value = this.getNestedValue(context, path);
      if (value !== undefined) {
        if (!usedVariables.includes(path)) {
          usedVariables.push(path);
        }
        return String(value);
      }
      return '';
    });

    return result.trim();
  }

  private getNestedValue(obj: unknown, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }
      if (typeof current === 'object') {
        current = (current as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }

    return current;
  }

  private combinePrompts(systemPrompt: string, userPrompt: string): string {
    const parts: string[] = [];

    if (systemPrompt) {
      parts.push('## System Instructions');
      parts.push(systemPrompt);
      parts.push('');
    }

    if (userPrompt) {
      parts.push('## Task');
      parts.push(userPrompt);
    }

    return parts.join('\n');
  }

  private initializeBuiltins(): void {
    // 注册内置 Profile 模板
    this.registerBuiltinProfileTemplates();
    // 注册内置 Prompt 模板
    this.registerBuiltinPromptTemplates();
    // 注册内置 Workflow 模板
    this.registerBuiltinWorkflowTemplates();
  }

  private registerBuiltinProfileTemplates(): void {
    const profiles: ProfileTemplate[] = [
      {
        id: 'builtin-developer-v1',
        name: 'Developer Agent',
        type: 'profile',
        description: 'Software development agent focused on code implementation',
        version: '1.0.0',
        tags: ['development', 'coding'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        profile: {
          name: 'Developer Agent',
          role: 'developer',
          description: 'Software development agent focused on code implementation',
          systemPolicy: `You are a software developer agent. Your primary responsibilities:
1. Analyze requirements and existing code
2. Implement features and fix bugs
3. Write tests for your code
4. Document your changes

Always:
- Read existing code before making changes
- Write clear commit messages
- Follow existing code patterns`,
          executionStrategy: 'PLAN_FIRST',
          scoringRule: {
            criteria: [
              { name: 'code_quality', description: 'Code follows best practices', weight: 0.3, evaluationPrompt: 'Rate code quality 0-100' },
              { name: 'test_coverage', description: 'Tests cover new code', weight: 0.3, evaluationPrompt: 'Rate test coverage 0-100' },
              { name: 'documentation', description: 'Changes are documented', weight: 0.2, evaluationPrompt: 'Rate documentation 0-100' },
              { name: 'completion', description: 'Task is fully completed', weight: 0.2, evaluationPrompt: 'Rate completion 0-100' },
            ],
            minScore: 60,
            autoRollback: true,
          },
          memoryPolicy: {
            maxActiveLines: 1500,
            maxTokens: 60000,
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
          doneDefinition: {
            conditions: [
              { type: 'test_pass', expression: 'All tests pass', required: true },
            ],
            requireConfirmation: false,
          },
          outputProtocol: {
            requiredFields: ['changes', 'tests', 'summary'],
            format: 'structured',
            requireSummary: true,
            requireCommitMessage: true,
          },
          selfEvolve: false,
          constraints: [
            { type: 'forbidden', description: 'No deletion without confirmation', rule: 'delete_*', severity: 'error' },
          ],
          requiredTools: ['read', 'write', 'bash'],
          tags: ['development', 'coding'],
        },
      },
      {
        id: 'builtin-product-v1',
        name: 'Product Agent',
        type: 'profile',
        description: 'Product management agent for requirements and planning',
        version: '1.0.0',
        tags: ['product', 'requirements'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        profile: {
          name: 'Product Agent',
          role: 'product',
          description: 'Product management agent for requirements and planning',
          systemPolicy: `You are a product manager agent. Your responsibilities:
1. Analyze user requirements
2. Create detailed specifications
3. Prioritize features
4. Identify conflicts and dependencies

Always:
- Think from user perspective
- Consider edge cases
- Document decisions`,
          executionStrategy: 'EXPLORE',
          scoringRule: {
            criteria: [
              { name: 'completeness', description: 'Requirements are complete', weight: 0.4, evaluationPrompt: 'Rate completeness 0-100' },
              { name: 'clarity', description: 'Requirements are clear', weight: 0.3, evaluationPrompt: 'Rate clarity 0-100' },
              { name: 'conflicts', description: 'Conflicts are identified', weight: 0.3, evaluationPrompt: 'Rate conflict detection 0-100' },
            ],
            minScore: 70,
            autoRollback: false,
          },
          memoryPolicy: {
            maxActiveLines: 1000,
            maxTokens: 40000,
            compactionThreshold: 3,
            autoArchive: true,
            retentionDays: 60,
            semanticIndex: false,
          },
          iterationPolicy: {
            maxIterations: 10,
            maxRounds: 20,
            iterationTimeoutMs: 180000,
            allowEarlyTermination: true,
            cooldownMs: 2000,
          },
          doneDefinition: {
            conditions: [
              { type: 'output_exists', expression: 'Requirements document created', required: true },
            ],
            requireConfirmation: true,
          },
          outputProtocol: {
            requiredFields: ['requirements', 'priorities', 'risks'],
            format: 'markdown',
            requireSummary: true,
            requireCommitMessage: false,
          },
          selfEvolve: false,
          constraints: [],
          requiredTools: ['read', 'write'],
          tags: ['product', 'requirements'],
        },
      },
      {
        id: 'builtin-tester-v1',
        name: 'Tester Agent',
        type: 'profile',
        description: 'Testing agent for quality assurance',
        version: '1.0.0',
        tags: ['testing', 'qa'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        profile: {
          name: 'Tester Agent',
          role: 'tester',
          description: 'Testing agent for quality assurance',
          systemPolicy: `You are a QA engineer agent. Your responsibilities:
1. Write test cases
2. Execute tests
3. Report bugs
4. Verify fixes

Always:
- Cover edge cases
- Document test scenarios
- Provide reproducible steps for bugs`,
          executionStrategy: 'TEST_DRIVEN',
          scoringRule: {
            criteria: [
              { name: 'coverage', description: 'Test coverage achieved', weight: 0.4, evaluationPrompt: 'Rate coverage 0-100' },
              { name: 'quality', description: 'Test quality', weight: 0.3, evaluationPrompt: 'Rate test quality 0-100' },
              { name: 'bugs_found', description: 'Bugs identified', weight: 0.3, evaluationPrompt: 'Rate bug detection 0-100' },
            ],
            minScore: 50,
            autoRollback: false,
          },
          memoryPolicy: {
            maxActiveLines: 800,
            maxTokens: 30000,
            compactionThreshold: 4,
            autoArchive: true,
            retentionDays: 30,
            semanticIndex: false,
          },
          iterationPolicy: {
            maxIterations: 5,
            maxRounds: 30,
            iterationTimeoutMs: 300000,
            allowEarlyTermination: true,
            cooldownMs: 1000,
          },
          doneDefinition: {
            conditions: [
              { type: 'test_pass', expression: 'All new tests pass', required: true },
            ],
            requireConfirmation: false,
          },
          outputProtocol: {
            requiredFields: ['test_cases', 'results', 'bugs'],
            format: 'structured',
            requireSummary: true,
            requireCommitMessage: false,
          },
          selfEvolve: false,
          constraints: [],
          requiredTools: ['read', 'write', 'bash'],
          tags: ['testing', 'qa'],
        },
      },
    ];

    profiles.forEach(p => {
      this.registry.set(p.id, { template: p, builtin: true, usageCount: 0 });
    });
  }

  private registerBuiltinPromptTemplates(): void {
    const prompts: PromptTemplate[] = [
      {
        id: 'builtin-task-prompt',
        name: 'Standard Task Prompt',
        type: 'prompt',
        description: 'Standard template for task execution',
        version: '1.0.0',
        tags: ['task', 'general'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        systemTemplate: `You are {{role}} agent working on workflow "{{workflowName}}".

Current round: {{round}} of {{maxRounds}}

Follow your role's guidelines and complete the task efficiently.`,
        userTemplate: `## Task
{{task}}

{{#if memory}}
## Memory
{{memory}}
{{/if}}

{{#if userInput}}
## User Input
{{userInput}}
{{/if}}

Please proceed with your task.`,
        variables: [
          { name: 'role', type: 'string', required: true },
          { name: 'workflowName', type: 'string', required: true },
          { name: 'round', type: 'number', required: true },
          { name: 'maxRounds', type: 'number', required: false, defaultValue: 50 },
          { name: 'task', type: 'string', required: true },
          { name: 'memory', type: 'string', required: false },
          { name: 'userInput', type: 'string', required: false },
        ],
      },
      {
        id: 'builtin-review-prompt',
        name: 'Code Review Prompt',
        type: 'prompt',
        description: 'Template for code review tasks',
        version: '1.0.0',
        tags: ['review', 'quality'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        systemTemplate: `You are a code reviewer. Your job is to:
1. Review code changes
2. Identify potential issues
3. Suggest improvements
4. Verify best practices

Be thorough but constructive.`,
        userTemplate: `## Code to Review
\`\`\`
{{code}}
\`\`\`

{{#if criteria}}
## Review Criteria
{{#each criteria}}
- {{this}}
{{/each}}
{{/if}}

Please review and provide:
1. Overall assessment
2. Issues found
3. Suggestions
4. Approval status`,
        variables: [
          { name: 'code', type: 'string', required: true },
          { name: 'criteria', type: 'array', required: false },
        ],
      },
    ];

    prompts.forEach(p => {
      this.registry.set(p.id, { template: p, builtin: true, usageCount: 0 });
    });
  }

  private registerBuiltinWorkflowTemplates(): void {
    const workflows: WorkflowTemplate[] = [
      {
        id: 'builtin-dev-pipeline',
        name: 'Development Pipeline',
        type: 'workflow',
        description: 'Standard development pipeline with product, dev, and test agents',
        version: '1.0.0',
        tags: ['pipeline', 'development'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        workflow: {
          name: 'Development Pipeline',
          description: 'Standard development pipeline',
          mode: 'continuous',
          nodes: [
            {
              id: 'product-node',
              name: 'Product Analysis',
              role: 'product',
              templateId: 'builtin-product-v1',
              triggerType: 'start',
            },
            {
              id: 'dev-node',
              name: 'Development',
              role: 'developer',
              templateId: 'builtin-developer-v1',
              dependsOn: ['product-node'],
              triggerType: 'dependency',
            },
            {
              id: 'test-node',
              name: 'Testing',
              role: 'tester',
              templateId: 'builtin-tester-v1',
              dependsOn: ['dev-node'],
              triggerType: 'dependency',
            },
          ],
        },
      },
      {
        id: 'builtin-feature-flow',
        name: 'Feature Development Flow',
        type: 'workflow',
        description: 'Simplified feature development flow',
        version: '1.0.0',
        tags: ['feature', 'development'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        workflow: {
          name: 'Feature Development Flow',
          description: 'Simplified feature development',
          mode: 'event',
          nodes: [
            {
              id: 'dev',
              name: 'Developer',
              role: 'developer',
              templateId: 'builtin-developer-v1',
              triggerType: 'start',
              priority: 1,
            },
            {
              id: 'test',
              name: 'Tester',
              role: 'tester',
              templateId: 'builtin-tester-v1',
              subscribeEvents: ['DEV_CODE_READY'],
              triggerType: 'event',
              priority: 2,
            },
          ],
        },
      },
    ];

    workflows.forEach(w => {
      this.registry.set(w.id, { template: w, builtin: true, usageCount: 0 });
    });
  }
}

// ============================================================================
// Global Instance
// ============================================================================

let globalTemplateEngine: TemplateEngine | null = null;

/**
 * 获取全局模板引擎
 */
export function getTemplateEngine(): TemplateEngine {
  if (!globalTemplateEngine) {
    globalTemplateEngine = new TemplateEngine();
  }
  return globalTemplateEngine;
}

/**
 * 重置全局模板引擎
 */
export function resetTemplateEngine(): void {
  globalTemplateEngine = null;
}

// ============================================================================
// Exports
// ============================================================================

export * from './types';
