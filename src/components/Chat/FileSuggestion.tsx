/**
 * 统一建议下拉组件 - 合并工作区、文件、快捷片段、Skill 和 MCP 建议
 */

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { FileMatch } from '@/services/fileSearch';
import type { Workspace, EngineId } from '@/types';
import type { PromptSnippet } from '@/types/promptSnippet';
import type { SkillItem as SkillItemType } from '@/types/skill';
import type { CliCommandSuggestion } from '@/services/cliSlashCommands';
import { getEngineDisplayName } from '@/utils/engineDisplay';

// 分离文件名和目录路径
function splitPath(relativePath: string): { dir: string; name: string } {
  const parts = relativePath.split(/[/\\]/);
  const name = parts[parts.length - 1];
  const dir = parts.slice(0, -1).join('/');
  return { dir, name };
}

/** @对话 引用的历史会话条目 */
export interface ConversationSuggestion {
  externalId: string;
  title: string;
  engineId: EngineId;
  messageCount: number;
  updatedAt: string;
  /** 源对话所属工作区路径（落盘 .polaris-handoff/ 用，优先于当前会话工作区） */
  workspacePath: string | null;
}

/** 专家参数补全条目(/agent、/dispatch、/nexus 的参数建议) */
export interface AgentArgSuggestion {
  slug: string;
  name: string;
  description: string;
  emoji?: string;
  /** 选中后替换整条命令的文本 */
  insertText: string;
}

export interface SuggestionItem {
  type: 'workspace' | 'file' | 'snippet' | 'skill' | 'mcp' | 'conversation' | 'cli-command' | 'agent';
  data: Workspace | FileMatch | PromptSnippet | SkillItemType | ConversationSuggestion | McpServerItem | CliCommandSuggestion | AgentArgSuggestion;
}

/** Skill 条目（用于 / 命令建议） */
export interface McpServerItem {
  id: string;
  name: string;
  description?: string;
}

/** MCP Server 条目（用于 / 命令建议） */
// Note: SkillItem is now imported from @/types/skill as SkillItemType

interface UnifiedSuggestionProps {
  items: SuggestionItem[];
  selectedIndex: number;
  onSelect: (item: SuggestionItem) => void;
  onHover: (index: number) => void;
  position: { top: number; left: number };
  currentWorkspaceId: string | null;
}

export function UnifiedSuggestion({
  items,
  selectedIndex,
  onSelect,
  onHover,
  position,
  currentWorkspaceId,
}: UnifiedSuggestionProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation('promptSnippet');
  const { t: tChat } = useTranslation('chat');

  // 滚动选中项到视图
  useEffect(() => {
    if (containerRef.current) {
      const selectedEl = containerRef.current.querySelector(`[data-index="${selectedIndex}"]`) as HTMLElement;
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex]);

  if (items.length === 0) {
    return null;
  }

  // 分组
  const workspaceItems = items.filter(i => i.type === 'workspace');
  const fileItems = items.filter(i => i.type === 'file');
  const snippetItems = items.filter(i => i.type === 'snippet');
  const cliCommandItems = items.filter(i => i.type === 'cli-command');
  const agentItems = items.filter(i => i.type === 'agent');
  const skillItems = items.filter(i => i.type === 'skill');
  const mcpItems = items.filter(i => i.type === 'mcp');
  const conversationItems = items.filter(i => i.type === 'conversation');

  return (
    <div
      ref={containerRef}
      className="fixed z-50 bg-background-surface border border-border rounded-lg shadow-lg max-h-80 overflow-auto"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
        minWidth: '280px',
        maxWidth: '450px',
      }}
    >
      {/* 工作区分组 */}
      {workspaceItems.length > 0 && (
        <>
          <div className="px-3 py-1.5 text-xs text-text-tertiary border-b border-border bg-background-elevated/50 sticky top-0">
            工作区
          </div>
          {workspaceItems.map((item) => {
            const globalIdx = items.findIndex(i => i === item);
            const workspace = item.data as Workspace;
            const isCurrent = workspace.id === currentWorkspaceId;

            return (
              <div
                key={workspace.id}
                data-index={globalIdx}
                className={`px-3 py-2 cursor-pointer flex items-center gap-2 text-sm ${
                  globalIdx === selectedIndex
                    ? 'bg-primary/20 text-text-primary'
                    : 'text-text-secondary hover:bg-background-hover'
                }`}
                onClick={() => onSelect(item)}
                onMouseEnter={() => onHover(globalIdx)}
              >
                <span className="shrink-0">
                  {isCurrent ? (
                    <span className="w-2 h-2 rounded-full bg-primary inline-block" />
                  ) : (
                    <span className="w-2 h-2 rounded-full bg-primary/50 inline-block" />
                  )}
                </span>
                <span className="flex-1 truncate font-medium">{workspace.name}</span>
                {isCurrent && (
                  <span className="text-xs text-text-tertiary bg-background-elevated px-1.5 py-0.5 rounded shrink-0">
                    当前
                  </span>
                )}
              </div>
            );
          })}
        </>
      )}

      {/* 文件分组 */}
      {fileItems.length > 0 && (
        <>
          <div className="px-3 py-1.5 text-xs text-text-tertiary border-b border-border bg-background-elevated/50 sticky top-0">
            当前工作区文件
          </div>
          {fileItems.map((item) => {
            const globalIdx = items.findIndex(i => i === item);
            const file = item.data as FileMatch;
            const { dir, name } = splitPath(file.relativePath);

            return (
              <div
                key={file.fullPath}
                data-index={globalIdx}
                className={`px-3 py-2 cursor-pointer flex items-center gap-2 text-sm ${
                  globalIdx === selectedIndex
                    ? 'bg-primary/20 text-text-primary'
                    : 'text-text-secondary hover:bg-background-hover'
                }`}
                onClick={() => onSelect(item)}
                onMouseEnter={() => onHover(globalIdx)}
              >
                <span className="shrink-0">
                  {file.isDir ? (
                    <svg className="w-4 h-4 text-warning" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  )}
                </span>
                <div className="flex-1 min-w-0 flex items-center gap-1.5">
                  {dir && (
                    <span className="text-text-tertiary text-xs truncate" title={dir}>
                      {dir}/
                    </span>
                  )}
                  <span className="font-medium truncate" title={name}>
                    {name}
                  </span>
                </div>
                {file.extension && !file.isDir && (
                  <span className="text-xs text-text-tertiary bg-background-elevated px-1.5 py-0.5 rounded shrink-0">
                    {file.extension}
                  </span>
                )}
              </div>
            );
          })}
        </>
      )}

      {/* 快捷片段分组 */}
      {snippetItems.length > 0 && (
        <>
          <div className="px-3 py-1.5 text-xs text-text-tertiary border-b border-border bg-background-elevated/50 sticky top-0">
            {t('chat.groupLabel')}
          </div>
          {snippetItems.map((item) => {
            const globalIdx = items.findIndex(i => i === item);
            const snippet = item.data as PromptSnippet;

            return (
              <div
                key={snippet.id}
                data-index={globalIdx}
                className={`px-3 py-2 cursor-pointer flex items-center gap-2 text-sm ${
                  globalIdx === selectedIndex
                    ? 'bg-primary/20 text-text-primary'
                    : 'text-text-secondary hover:bg-background-hover'
                }`}
                onClick={() => onSelect(item)}
                onMouseEnter={() => onHover(globalIdx)}
              >
                <span className="font-mono text-sm text-text-primary shrink-0">/{snippet.name}</span>
                {snippet.description && (
                  <span className="text-xs text-text-tertiary truncate">{snippet.description}</span>
                )}
              </div>
            );
          })}
        </>
      )}

      {/* CLI 命令分组（Claude 引擎会话，消息以 / 开头时由 CLI 直接执行） */}
      {cliCommandItems.length > 0 && (
        <>
          <div className="px-3 py-1.5 text-xs text-text-tertiary border-b border-border bg-background-elevated/50 sticky top-0">
            {tChat('cliCommand.groupLabel')}
          </div>
          {cliCommandItems.map((item) => {
            const globalIdx = items.findIndex(i => i === item);
            const cmd = item.data as CliCommandSuggestion;

            return (
              <div
                key={`cli-${cmd.name}`}
                data-index={globalIdx}
                className={`px-3 py-2 cursor-pointer flex items-center gap-2 text-sm ${
                  globalIdx === selectedIndex
                    ? 'bg-primary/20 text-text-primary'
                    : 'text-text-secondary hover:bg-background-hover'
                }`}
                onClick={() => onSelect(item)}
                onMouseEnter={() => onHover(globalIdx)}
              >
                <span className="font-mono text-sm text-amber-500 shrink-0">/{cmd.name}</span>
                {cmd.argumentHint && (
                  <span className="font-mono text-xs text-text-tertiary shrink-0">{cmd.argumentHint}</span>
                )}
                <span className="text-xs text-text-tertiary truncate">
                  {tChat(`cliCommand.desc.${cmd.descKey}`)}
                </span>
              </div>
            );
          })}
        </>
      )}

      {/* 专家参数补全分组 */}
      {agentItems.length > 0 && (
        <>
          <div className="px-3 py-1.5 text-xs text-text-tertiary border-b border-border bg-background-elevated/50 sticky top-0">
            专家
          </div>
          {agentItems.map((item) => {
            const globalIdx = items.findIndex(i => i === item);
            const agent = item.data as AgentArgSuggestion;

            return (
              <div
                key={`agent-${agent.slug}`}
                data-index={globalIdx}
                className={`px-3 py-2 cursor-pointer flex items-center gap-2 text-sm ${
                  globalIdx === selectedIndex
                    ? 'bg-primary/20 text-text-primary'
                    : 'text-text-secondary hover:bg-background-hover'
                }`}
                onClick={() => onSelect(item)}
                onMouseEnter={() => onHover(globalIdx)}
              >
                <span className="shrink-0">{agent.emoji || '🤖'}</span>
                <span className="shrink-0 text-sm">{agent.name}</span>
                <span className="font-mono text-xs text-text-tertiary shrink-0">{agent.slug}</span>
                <span className="text-xs text-text-tertiary truncate">{agent.description}</span>
              </div>
            );
          })}
        </>
      )}

      {/* Skill 分组 */}
      {skillItems.length > 0 && (
        <>
          <div className="px-3 py-1.5 text-xs text-text-tertiary border-b border-border bg-background-elevated/50 sticky top-0">
            Skill
          </div>
          {skillItems.map((item) => {
            const globalIdx = items.findIndex(i => i === item);
            const skill = item.data as SkillItemType;

            return (
              <div
                key={skill.id}
                data-index={globalIdx}
                className={`px-3 py-2 cursor-pointer flex items-center gap-2 text-sm ${
                  globalIdx === selectedIndex
                    ? 'bg-primary/20 text-text-primary'
                    : 'text-text-secondary hover:bg-background-hover'
                }`}
                onClick={() => onSelect(item)}
                onMouseEnter={() => onHover(globalIdx)}
              >
                <span className="font-mono text-sm text-green-500 shrink-0">/{skill.name}</span>
                {skill.description && (
                  <span className="text-xs text-text-tertiary truncate">{skill.description}</span>
                )}
              </div>
            );
          })}
        </>
      )}

      {/* MCP 分组 */}
      {mcpItems.length > 0 && (
        <>
          <div className="px-3 py-1.5 text-xs text-text-tertiary border-b border-border bg-background-elevated/50 sticky top-0">
            MCP 插件
          </div>
          {mcpItems.map((item) => {
            const globalIdx = items.findIndex(i => i === item);
            const mcp = item.data as McpServerItem;

            return (
              <div
                key={mcp.id}
                data-index={globalIdx}
                className={`px-3 py-2 cursor-pointer flex items-center gap-2 text-sm ${
                  globalIdx === selectedIndex
                    ? 'bg-primary/20 text-text-primary'
                    : 'text-text-secondary hover:bg-background-hover'
                }`}
                onClick={() => onSelect(item)}
                onMouseEnter={() => onHover(globalIdx)}
              >
                <span className="font-mono text-sm text-blue-500 shrink-0">/{mcp.id}</span>
                {mcp.name && (
                  <span className="text-xs text-text-tertiary truncate">{mcp.name}</span>
                )}
              </div>
            );
          })}
        </>
      )}

      {/* 历史对话分组（@对话 引用） */}
      {conversationItems.length > 0 && (
        <>
          <div className="px-3 py-1.5 text-xs text-text-tertiary border-b border-border bg-background-elevated/50 sticky top-0">
            历史对话
          </div>
          {conversationItems.map((item) => {
            const globalIdx = items.findIndex(i => i === item);
            const conv = item.data as ConversationSuggestion;

            return (
              <div
                key={conv.externalId}
                data-index={globalIdx}
                className={`px-3 py-2 cursor-pointer flex items-center gap-2 text-sm ${
                  globalIdx === selectedIndex
                    ? 'bg-primary/20 text-text-primary'
                    : 'text-text-secondary hover:bg-background-hover'
                }`}
                onClick={() => onSelect(item)}
                onMouseEnter={() => onHover(globalIdx)}
              >
                <svg className="w-4 h-4 text-text-tertiary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.8L3 20l1.3-3.9A7.97 7.97 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                <span className="flex-1 truncate font-medium" title={conv.title}>{conv.title}</span>
                <span className="text-xs text-text-tertiary bg-background-elevated px-1.5 py-0.5 rounded shrink-0">
                  {getEngineDisplayName(conv.engineId)}
                </span>
                <span className="text-xs text-text-tertiary shrink-0">{conv.messageCount}条</span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}