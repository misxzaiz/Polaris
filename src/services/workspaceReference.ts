/**
 * 工作区引用服务 - 处理 @workspace:path 和 @path 语法
 *
 * 支持两种引用格式:
 * - @path - 引用当前工作区的文件（更简洁，常用场景）
 * - @workspace:path - 引用指定工作区的文件（跨工作区）
 */

import i18n from 'i18next';
import type { Workspace, WorkspaceReference, ParsedWorkspaceMessage } from '../types';
import { getSystemPromptConfigDirect } from './systemPromptStore';

/**
 * 匹配 @workspace:path 和 @path 格式
 * - @workspace:path: @ 后跟工作区名和冒号
 * - @path: @ 后直接跟路径（包含 / \ 或 . 的字符串）
 */
const WORKSPACE_REF_PATTERN = /@(?:([\w\u4e00-\u9fa5-]+):)?([^\s]+)/g;

/**
 * 检查字符串是否像文件路径
 */
function looksLikeFilePath(str: string): boolean {
  // 包含路径分隔符或文件扩展名的点
  return str.includes('/') || str.includes('\\') || str.includes('.');
}

/**
 * 解析消息中的工作区引用
 *
 * @example
 * // 引用当前工作区（新语法，推荐）
 * parseWorkspaceReferences("查看 @src/App.tsx", ...)
 * // → processedMessage: "查看 @/current/path/src/App.tsx"
 *
 * @example
 * // 引用其他工作区（跨工作区）
 * parseWorkspaceReferences("参考 @utils:src/Button.tsx", ...)
 * // → processedMessage: "参考 @/abs/path/utils/src/Button.tsx"
 *
 * @example
 * // 兼容旧语法 @/path
 * parseWorkspaceReferences("查看 @/src/App.tsx", ...)
 * // → processedMessage: "查看 @/current/path/src/App.tsx"
 */
export function parseWorkspaceReferences(
  message: string,
  workspaces: Workspace[],
  contextWorkspaces: Workspace[],
  currentWorkspaceId: string | null
): ParsedWorkspaceMessage {
  const references: WorkspaceReference[] = [];
  let processed = message;

  // 获取当前工作区
  const currentWorkspace = workspaces.find(w => w.id === currentWorkspaceId);

  // 预构建名称索引，O(1) 查找
  const workspaceByName = new Map<string, Workspace>();
  for (const w of workspaces) {
    if (w && w.name) {
      workspaceByName.set(w.name.toLowerCase(), w);
    }
  }

  // 存储匹配结果和位置，避免正则 lastIndex 问题
  const matches: Array<{
    fullMatch: string;
    workspaceName: string | null;  // null 表示当前工作区
    relativePath: string;
    startIndex: number;
    endIndex: number;
  }> = [];

  // 重置正则索引
  WORKSPACE_REF_PATTERN.lastIndex = 0;

  // 收集所有匹配
  let match: RegExpExecArray | null;
  while ((match = WORKSPACE_REF_PATTERN.exec(message)) !== null) {
    const fullMatch = match[0];
    const capturedWorkspaceName = match[1];  // 可能为 undefined
    const capturedPath = match[2];

    let workspaceName: string | null = null;
    let relativePath: string;

    if (capturedWorkspaceName) {
      // 格式: @workspace:path
      // 需要判断 workspaceName 是真正的工作区名还是路径的一部分

      // 检查冒号后的部分是否像路径
      const pathLooksLikeFile = looksLikeFilePath(capturedPath);

      if (pathLooksLikeFile) {
        // 冒号后是路径格式，检查冒号前是否是已知工作区
        const isKnownWorkspace = workspaceByName.has(capturedWorkspaceName.toLowerCase());

        if (isKnownWorkspace) {
          // 是已知工作区名，作为跨工作区引用
          workspaceName = capturedWorkspaceName;
          relativePath = capturedPath;
        } else {
          // 不是已知工作区名，可能是当前工作区的路径（如 @src:App.tsx -> src/App.tsx）
          // 但这种情况比较少见，更可能是打字错误，暂不处理
          // 实际上这种情况我们跳过，让用户修正
          continue;
        }
      } else {
        // 冒号后不是路径格式，跳过（可能是邮箱等）
        continue;
      }
    } else {
      // 格式: @path（当前工作区）
      relativePath = capturedPath;

      // 如果是旧语法 @/path，去掉开头的 /
      if (relativePath.startsWith('/')) {
        relativePath = relativePath.slice(1);
      }

      // 过滤掉明显不是路径的匹配
      if (!looksLikeFilePath(relativePath)) {
        continue;
      }
    }

    matches.push({
      fullMatch,
      workspaceName,
      relativePath,
      startIndex: match.index,
      endIndex: match.index + fullMatch.length,
    });
  }

  // 从后往前替换，避免索引变化
  for (let i = matches.length - 1; i >= 0; i--) {
    const { fullMatch, workspaceName, relativePath, startIndex, endIndex } = matches[i];

    let workspace: Workspace | undefined;
    let actualWorkspaceName: string;

    if (workspaceName) {
      // 指定了工作区名
      workspace = workspaceByName.get(workspaceName.toLowerCase());
      actualWorkspaceName = workspaceName;
    } else {
      // 未指定工作区名，使用当前工作区
      workspace = currentWorkspace;
      actualWorkspaceName = currentWorkspace?.name || '当前工作区';
    }

    if (workspace && workspace.path) {
      // 使用平台特定的路径分隔符
      const pathSeparator = workspace.path.includes('\\') ? '\\' : '/';
      const absolutePath = workspace.path + pathSeparator + relativePath;

      references.unshift({
        workspaceName: actualWorkspaceName,
        workspacePath: workspace.path,
        relativePath,
        absolutePath,
        originalText: fullMatch,
      });

      // 替换为绝对路径引用
      processed = processed.substring(0, startIndex) +
                 `@${absolutePath}` +
                 processed.substring(endIndex);
    }
  }

  // 生成上下文头
  const contextHeader = generateContextHeader(references, contextWorkspaces, workspaces, currentWorkspaceId);

  return {
    processedMessage: processed,
    references,
    contextHeader,
  };
}

/**
 * 生成工作区信息头
 */
function generateContextHeader(
  references: WorkspaceReference[],
  contextWorkspaces: Workspace[] | null | undefined,
  allWorkspaces: Workspace[],
  currentWorkspaceId: string | null
): string {
  const safeContextWorkspaces = contextWorkspaces ?? [];
  if (references.length === 0 && safeContextWorkspaces.length === 0) {
    return '';
  }

  const currentWorkspace = allWorkspaces.find(w => w.id === currentWorkspaceId);

  let header = '\n';
  header += '═══════════════════════════════════════════════════════════\n';
  header += '                        工作区信息\n';
  header += '═══════════════════════════════════════════════════════════\n';
  header += `当前工作区: ${currentWorkspace?.name || '未设置'}\n`;
  if (currentWorkspace) {
    header += `  路径: ${currentWorkspace.path}\n`;
    header += `  引用语法: @path 或 @/path\n`;
  }

  if (safeContextWorkspaces.length > 0) {
    header += '\n关联工作区:\n';
    safeContextWorkspaces.forEach(w => {
      if (w && w.name && w.path) {
        header += `  • ${w.name}\n`;
        header += `    路径: ${w.path}\n`;
        header += `    引用语法: @${w.name}:path\n`;
      }
    });
  }

  if (references.length > 0) {
    const referencedWorkspaces = new Set(references.map(r => r.workspaceName));
    header += '\n本次引用的工作区:\n';
    referencedWorkspaces.forEach(name => {
      header += `  • ${name}\n`;
    });
  }

  header += '═══════════════════════════════════════════════════════════\n';

  return header;
}

/**
 * 从工作区名获取工作区
 */
export function getWorkspaceByName(name: string, workspaces: Workspace[]): Workspace | undefined {
  return workspaces.find(w => w.name.toLowerCase() === name.toLowerCase());
}

/**
 * 验证工作区引用格式
 */
export function isValidWorkspaceReference(text: string): boolean {
  return /^@[\w\u4e00-\u9fa5-]+:/.test(text);
}

/**
 * 构建工作区上下文（结构化格式，用于 AITask.extra）
 *
 * @param workspaces 所有工作区列表
 * @param contextWorkspaces 关联工作区列表
 * @param currentWorkspaceId 当前工作区 ID
 * @returns 工作区上下文对象
 */
export function buildWorkspaceContextExtra(
  workspaces: Workspace[],
  contextWorkspaces: Workspace[],
  currentWorkspaceId: string | null
): { currentWorkspace: { name: string; path: string }; contextWorkspaces: Array<{ name: string; path: string }> } | null {
  const currentWorkspace = workspaces.find(w => w.id === currentWorkspaceId);

  if (!currentWorkspace) {
    return null;
  }

  return {
    currentWorkspace: {
      name: currentWorkspace.name,
      path: currentWorkspace.path,
    },
    contextWorkspaces: contextWorkspaces
      .filter(w => w && w.name && w.path)
      .map(w => ({
        name: w.name,
        path: w.path,
      })),
  };
}

/**
 * 构建默认系统提示词（工作区信息部分）
 *
 * 此部分始终传递，通过 --append-system-prompt 参数追加
 */
export function buildWorkspaceSystemPrompt(
  currentWorkspace: Workspace,
  contextWorkspaces: Workspace[]
): string {
  const t = i18n.t.bind(i18n);
  const lines: string[] = [];

  lines.push(t('systemPrompt:workingIn', { name: currentWorkspace.name }));
  lines.push(t('systemPrompt:projectPath', { path: currentWorkspace.path }));
  lines.push(t('systemPrompt:fileRefSyntax'));

  if (contextWorkspaces.length > 0) {
    lines.push(``);
    lines.push(t('systemPrompt:contextWorkspaces'));
    for (const ws of contextWorkspaces) {
      lines.push(`- ${ws.name} (${ws.path})`);
      lines.push(`  ${t('systemPrompt:refSyntax', { name: ws.name })}`);
    }
  }

  lines.push(``);
  lines.push(t('systemPrompt:workspaceToolGuidance'));

  return lines.join('\n');
}

/**
 * 解析模板变量
 *
 * 支持的变量:
 * - {{workspaceName}} 当前工作区名称
 * - {{workspacePath}} 当前工作区路径
 * - {{contextWorkspaces}} 关联工作区列表
 * - {{date}} 当前日期
 * - {{time}} 当前时间
 */
function resolveTemplateVariables(
  template: string,
  context: {
    workspaceName: string;
    workspacePath: string;
    contextWorkspaces: Workspace[];
  }
): string {
  const now = new Date();
  const contextList = context.contextWorkspaces
    .filter(w => w?.name && w?.path)
    .map(w => `- ${w.name} (${w.path})`)
    .join('\n');

  return template
    .replace(/\{\{workspaceName\}\}/g, context.workspaceName)
    .replace(/\{\{workspacePath\}\}/g, context.workspacePath)
    .replace(/\{\{contextWorkspaces\}\}/g, contextList)
    .replace(/\{\{date\}\}/g, now.toLocaleDateString())
    .replace(/\{\{time\}\}/g, now.toLocaleTimeString());
}

/**
 * 获取用户自定义系统提示词
 *
 * 仅在用户开启系统提示词功能且有内容时返回，否则返回 null
 * 此部分通过 --system-prompt 参数传递（会覆盖默认部分）
 */
export function getUserSystemPrompt(
  currentWorkspace: Workspace,
  contextWorkspaces: Workspace[]
): string | null {
  // 直接从 localStorage 读取配置，绕过 Zustand 的异步水合问题
  const config = getSystemPromptConfigDirect();

  console.log('[getUserSystemPrompt] 系统提示词配置:', {
    enabled: config?.enabled,
    hasCustomPrompt: !!config?.customPrompt?.trim(),
  })

  // 未启用或无自定义内容，返回 null
  if (!config?.enabled || !config.customPrompt?.trim()) {
    console.log('[getUserSystemPrompt] 未启用或无内容，返回 null')
    return null;
  }

  // 解析变量
  const resolvedPrompt = resolveTemplateVariables(config.customPrompt, {
    workspaceName: currentWorkspace.name,
    workspacePath: currentWorkspace.path,
    contextWorkspaces,
  });

  console.log('[getUserSystemPrompt] 用户自定义提示词长度:', resolvedPrompt.length)
  return resolvedPrompt;
}

