/**
 * Scheduler vNext - Context Builder
 *
 * 执行上下文构建器实现
 */

import type { Workflow, WorkflowNode, ExecutionRecord } from '../types';
import type { AgentProfile } from '../types/profile';
import type {
  NodeExecutionContext,
  PromptContext,
  ContextBuildOptions,
  UserInput,
  DependencyStatus,
  ContextInfo,
  ContextMemoryState,
} from './types';
import { DEFAULT_BUILD_OPTIONS } from './types';

// ============================================================================
// Context Builder Interface
// ============================================================================

/**
 * 上下文构建器接口
 */
export interface IContextBuilder {
  /** 构建节点执行上下文 */
  buildNodeContext(
    workflow: Workflow,
    node: WorkflowNode,
    options?: ContextBuildOptions
  ): Promise<NodeExecutionContext>;

  /** 构建提示词上下文 */
  buildPromptContext(
    context: NodeExecutionContext,
    options?: ContextBuildOptions
  ): PromptContext;

  /** 渲染提示词模板 */
  renderTemplate(template: string, vars: Record<string, string>): string;
}

// ============================================================================
// Context Builder Implementation
// ============================================================================

/**
 * 上下文构建器实现
 */
export class ContextBuilder implements IContextBuilder {
  private memoryState: ContextMemoryState;
  private executionHistory: Map<string, ExecutionRecord[]> = new Map();
  private userInputs: Map<string, UserInput[]> = new Map();
  private profiles: Map<string, AgentProfile> = new Map();

  constructor(
    memoryState?: ContextMemoryState,
    profiles?: AgentProfile[]
  ) {
    this.memoryState = memoryState || this.createEmptyMemoryState();
    if (profiles) {
      profiles.forEach(p => this.profiles.set(p.id, p));
    }
  }

  // --------------------------------------------------------------------------
  // Public Methods
  // --------------------------------------------------------------------------

  async buildNodeContext(
    workflow: Workflow,
    node: WorkflowNode,
    options?: ContextBuildOptions
  ): Promise<NodeExecutionContext> {
    const opts = { ...DEFAULT_BUILD_OPTIONS, ...options };
    const profile = node.templateId ? this.profiles.get(node.templateId) : undefined;

    return {
      workflow,
      node,
      profile,
      round: workflow.currentRound || 0,
      workDir: workflow.memoryRoot || '',
      memory: opts.includeMemory ? this.memoryState : this.createEmptyMemoryState(),
      pendingEvents: [],
      executionHistory: opts.includeHistory
        ? this.getNodeHistory(node.id, opts.maxHistoryItems)
        : [],
      userInputs: opts.includeUserInputs
        ? this.getUnprocessedInputs(node.id)
        : [],
      environment: {},
      extraConfig: opts.customVars,
    };
  }

  buildPromptContext(
    context: NodeExecutionContext,
    options?: ContextBuildOptions
  ): PromptContext {
    const opts = { ...DEFAULT_BUILD_OPTIONS, ...options };
    const { profile } = context;

    // 构建系统提示词
    const systemPrompt = this.buildSystemPrompt(context, profile);

    // 构建用户提示词
    const userPrompt = this.buildUserPrompt(context, profile);

    // 构建上下文信息
    const contextInfo = this.buildContextInfo(context);

    // 构建模板变量
    const templateVars = this.buildTemplateVars(context, opts.customVars);

    return {
      systemPrompt,
      userPrompt,
      contextInfo,
      templateVars,
    };
  }

  renderTemplate(template: string, vars: Record<string, string>): string {
    let result = template;

    // 替换 {{variable}} 格式的变量 (包括带空格的变量)
    result = result.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, varName) => {
      return vars[varName] !== undefined ? vars[varName] : '';
    });

    // 处理条件块 {{#if variable}}...{{/if}}
    result = result.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, varName, content) => {
      return vars[varName] ? content : '';
    });

    // 处理循环 {{#each items}}...{{/each}}
    // 简化实现，实际可能需要更复杂的逻辑

    return result.trim();
  }

  // --------------------------------------------------------------------------
  // State Management
  // --------------------------------------------------------------------------

  /**
   * 更新内存状态
   */
  updateMemoryState(state: ContextMemoryState): void {
    this.memoryState = state;
  }

  /**
   * 添加执行记录
   */
  addExecutionRecord(nodeId: string, record: ExecutionRecord): void {
    if (!this.executionHistory.has(nodeId)) {
      this.executionHistory.set(nodeId, []);
    }
    const records = this.executionHistory.get(nodeId);
    if (records) {
      records.push(record);
    }
  }

  /**
   * 添加用户输入
   */
  addUserInput(nodeId: string, input: UserInput): void {
    if (!this.userInputs.has(nodeId)) {
      this.userInputs.set(nodeId, []);
    }
    const inputs = this.userInputs.get(nodeId);
    if (inputs) {
      inputs.push(input);
    }
  }

  /**
   * 标记用户输入已处理
   */
  markInputProcessed(nodeId: string, inputId: string): void {
    const inputs = this.userInputs.get(nodeId);
    if (inputs) {
      const input = inputs.find(i => i.id === inputId);
      if (input) {
        input.processed = true;
      }
    }
  }

  /**
   * 注册 Profile
   */
  registerProfile(profile: AgentProfile): void {
    this.profiles.set(profile.id, profile);
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private buildSystemPrompt(
    context: NodeExecutionContext,
    profile?: AgentProfile
  ): string {
    const parts: string[] = [];

    // 基础角色提示
    if (profile) {
      parts.push(profile.systemPolicy);
      parts.push('');

      // 添加约束
      if (profile.constraints.length > 0) {
        parts.push('## Constraints');
        profile.constraints.forEach(c => {
          parts.push(`- [${c.severity.toUpperCase()}] ${c.description}: ${c.rule}`);
        });
        parts.push('');
      }

      // 添加输出协议
      if (profile.outputProtocol.requiredFields.length > 0) {
        parts.push('## Required Output Fields');
        profile.outputProtocol.requiredFields.forEach(f => {
          parts.push(`- ${f}`);
        });
        parts.push('');
      }
    } else {
      parts.push(`You are an AI assistant working on workflow "${context.workflow.name}".`);
      parts.push(`Your role is: ${context.node.role}`);
      parts.push('');
    }

    // 添加工作流上下文
    parts.push('## Workflow Context');
    parts.push(`- Workflow: ${context.workflow.name}`);
    parts.push(`- Current Round: ${context.round}`);
    parts.push(`- Node ID: ${context.node.id}`);
    parts.push('');

    return parts.join('\n');
  }

  private buildUserPrompt(
    context: NodeExecutionContext,
    profile?: AgentProfile
  ): string {
    const parts: string[] = [];

    // 添加内存摘要
    if (context.memory.active.length > 0) {
      parts.push('## Memory Summary');
      parts.push(this.formatMemorySummary(context.memory));
      parts.push('');
    }

    // 添加用户输入
    if (context.userInputs.length > 0) {
      parts.push('## User Inputs');
      context.userInputs.forEach(input => {
        parts.push(`### ${input.type.toUpperCase()} (${new Date(input.timestamp).toISOString()})`);
        parts.push(input.content);
        parts.push('');
      });
    }

    // 添加执行历史摘要
    if (context.executionHistory.length > 0) {
      parts.push('## Recent Executions');
      context.executionHistory.slice(-5).forEach((record, i) => {
        parts.push(`${i + 1}. Round ${record.round}: ${record.status}`);
        if (record.outputSnippet) {
          parts.push(`   Output: ${record.outputSnippet.substring(0, 100)}...`);
        }
      });
      parts.push('');
    }

    // 添加当前任务
    if (context.node.taskPrompt) {
      parts.push('## Current Task');
      parts.push(context.node.taskPrompt);
      parts.push('');
    }

    // 添加完成定义
    if (profile?.doneDefinition.conditions.length) {
      parts.push('## Completion Criteria');
      profile.doneDefinition.conditions.forEach(c => {
        if (c.required) {
          parts.push(`- [REQUIRED] ${c.expression}`);
        }
      });
      parts.push('');
    }

    return parts.join('\n');
  }

  private buildContextInfo(context: NodeExecutionContext): ContextInfo {
    const { workflow, node, round, executionHistory } = context;

    const memoryPolicy = context.profile?.memoryPolicy;
    const maxRounds = memoryPolicy?.compactionThreshold || 5;

    return {
      workflowName: workflow.name,
      nodeRole: node.role,
      round,
      maxRounds,
      dependencyStatus: this.getDependencyStatus(context),
      recentExecutions: executionHistory.slice(-5).map(r =>
        `Round ${r.round}: ${r.status}`
      ),
      pendingTasks: [],
    };
  }

  private buildTemplateVars(
    context: NodeExecutionContext,
    customVars: Record<string, string>
  ): Record<string, string> {
    return {
      workflowId: context.workflow.id,
      workflowName: context.workflow.name,
      nodeId: context.node.id,
      nodeRole: context.node.role,
      round: String(context.round),
      workDir: context.workDir,
      ...customVars,
    };
  }

  private formatMemorySummary(memory: ContextMemoryState): string {
    const parts: string[] = [];

    if (memory.active.length > 0) {
      parts.push('### Active Memory');
      parts.push(memory.active.slice(0, 10).join('\n'));
    }

    if (memory.summary) {
      parts.push('### Summary');
      parts.push(memory.summary);
    }

    return parts.join('\n');
  }

  private getDependencyStatus(context: NodeExecutionContext): DependencyStatus[] {
    const { node } = context;
    const statuses: DependencyStatus[] = [];

    if (node.dependsOn) {
      node.dependsOn.forEach(depId => {
        statuses.push({
          nodeId: depId,
          nodeName: depId, // 实际应查找节点名称
          status: 'completed', // 实际应检查真实状态
        });
      });
    }

    return statuses;
  }

  private getNodeHistory(nodeId: string, limit: number): ExecutionRecord[] {
    const history = this.executionHistory.get(nodeId) || [];
    return history.slice(-limit);
  }

  private getUnprocessedInputs(nodeId: string): UserInput[] {
    const inputs = this.userInputs.get(nodeId) || [];
    return inputs.filter(i => !i.processed);
  }

  private createEmptyMemoryState(): ContextMemoryState {
    return {
      active: [],
      summaries: [],
      archives: [],
      checkpoints: [],
      semantic: [],
      tasks: [],
      userInputs: [],
    };
  }
}

// ============================================================================
// Global Instance
// ============================================================================

let globalContextBuilder: ContextBuilder | null = null;

/**
 * 获取全局上下文构建器
 */
export function getContextBuilder(): ContextBuilder {
  if (!globalContextBuilder) {
    globalContextBuilder = new ContextBuilder();
  }
  return globalContextBuilder;
}

/**
 * 重置全局上下文构建器
 */
export function resetContextBuilder(): void {
  globalContextBuilder = null;
}

// ============================================================================
// Exports
// ============================================================================

export * from './types';
