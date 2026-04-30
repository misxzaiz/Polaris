/**
 * Git Commit Message Generator
 *
 * 使用 AI 生成 Git 提交消息
 * 使用独立的 contextId 避免与主聊天会话冲突
 */

import { invoke } from '@/services/transport'
import { getEventRouter, createContextId } from './eventRouter'
import type { GitDiffEntry } from '@/types/git'
import { createLogger } from '../utils/logger'
import { useConfigStore } from '../stores/configStore'
import { normalizeEngineId } from '../utils/engineDisplay'
import {
  isAIEvent,
  isTokenEvent,
  isAssistantMessageEvent,
  isSessionStartEvent,
  isSessionEndEvent,
  isErrorEvent,
  isResultEvent,
  type AIEvent,
} from '../ai-runtime'

const log = createLogger('CommitMessageGenerator')

export interface GenerateCommitMessageOptions {
  workspacePath: string
  stagedDiffs?: GitDiffEntry[]
  maxDiffLength?: number
}

const SYSTEM_PROMPT = `You are a Git commit message generator. Your task is to analyze the staged changes and generate a concise, meaningful commit message following conventional commits format.

Rules:
1. Use conventional commits format: type(scope): description
2. Types: feat, fix, docs, style, refactor, test, chore, perf, ci, build, revert
3. Keep the first line under 72 characters
4. Use imperative mood ("add feature" not "added feature")
5. Don't end the first line with a period
6. If there are multiple types of changes, focus on the most significant one
7. Respond with ONLY the commit message, no explanations

Examples:
- feat(auth): add OAuth2 login support
- fix(api): handle null response in user endpoint
- docs(readme): update installation instructions
- refactor(utils): simplify date formatting logic
- chore(deps): update dependencies to latest versions`

const MAX_DIFF_LENGTH = 6000

export async function generateCommitMessage(
  options: GenerateCommitMessageOptions
): Promise<string> {
  const { workspacePath, stagedDiffs, maxDiffLength = MAX_DIFF_LENGTH } = options

  let diffContent = ''

  try {
    if (stagedDiffs && stagedDiffs.length > 0) {
      diffContent = formatDiffs(stagedDiffs, maxDiffLength)
    } else {
      const diffs = await invoke<GitDiffEntry[]>('git_get_index_diff', {
        workspacePath,
      })

      if (diffs.length === 0) {
        throw new Error('No staged changes found')
      }

      diffContent = formatDiffs(diffs, maxDiffLength)
    }
  } catch (err) {
    log.error('Failed to get diff', err instanceof Error ? err : new Error(String(err)))
    throw new Error('Failed to get staged changes')
  }

  if (!diffContent) {
    throw new Error('No changes to analyze')
  }

  const userPrompt = `Analyze the following staged Git changes and generate a commit message:

${diffContent}

Generate a commit message (respond with ONLY the message):`

  const contextId = createContextId('git-commit')

  try {
    const result = await callAIForCommitMessage(workspacePath, SYSTEM_PROMPT, userPrompt, contextId)
    return result
  } catch (err) {
    log.error('AI generation failed', err instanceof Error ? err : new Error(String(err)))
    return generateFallbackMessage(diffContent)
  }
}

function formatDiffs(diffs: GitDiffEntry[], maxLength: number): string {
  return diffs
    .map((diff) => {
      const header = `File: ${diff.file_path} (${diff.change_type})`
      const oldContent = diff.old_content 
        ? `--- Old ---\n${diff.old_content.slice(0, 800)}` 
        : ''
      const newContent = diff.new_content 
        ? `+++ New ---\n${diff.new_content.slice(0, 800)}` 
        : ''
      return `${header}\n${oldContent}\n${newContent}`
    })
    .join('\n\n')
    .slice(0, maxLength)
}

async function callAIForCommitMessage(
  workDir: string,
  systemPrompt: string,
  userPrompt: string,
  contextId: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    (async () => {
      let accumulatedText = ''
      let timeoutId: ReturnType<typeof setTimeout> | null = null
      let unregister: (() => void) | null = null

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }
        if (unregister) {
          unregister()
          unregister = null
        }
      }

      const handleTimeout = () => {
        cleanup()
        if (accumulatedText) {
          resolve(extractCommitMessage(accumulatedText))
        } else {
          reject(new Error('AI generation timeout'))
        }
      }

      timeoutId = setTimeout(handleTimeout, 30000)

      try {
        const router = getEventRouter()
        await router.initialize()

        unregister = router.register(contextId, (payload: unknown) => {
          try {
            // 使用类型守卫验证事件
            if (!isAIEvent(payload)) {
              return
            }

            const event = payload as AIEvent

            if (isSessionStartEvent(event)) {
              // 会话开始，无需处理
              return
            }

            if (isAssistantMessageEvent(event)) {
              // AI 消息事件
              if (event.content) {
                accumulatedText += event.content
              }
              return
            }

            if (isTokenEvent(event)) {
              // Token 增量事件
              if (event.value) {
                accumulatedText += event.value
              }
              return
            }

            if (isSessionEndEvent(event) || isResultEvent(event)) {
              // 会话结束或结果事件
              cleanup()
              if (accumulatedText) {
                resolve(extractCommitMessage(accumulatedText))
              } else {
                reject(new Error('No response from AI'))
              }
              return
            }

            if (isErrorEvent(event)) {
              // 错误事件
              cleanup()
              reject(new Error(event.error || 'AI generation failed'))
              return
            }
          } catch (e) {
            log.error('Failed to process event:', e instanceof Error ? e : new Error(String(e)))
          }
        })

        const fullPrompt = `${systemPrompt}\n\n${userPrompt}`
        
        const engineId = normalizeEngineId(useConfigStore.getState().config?.defaultEngine)

        await invoke<string>('start_chat', {
          message: fullPrompt.replace(/\n/g, '\\n'),
          options: {
            workDir,
            engineId,
            contextId,
          },
        })
      } catch (err) {
        cleanup()
        reject(err)
      }
    })().catch(reject);
  })
}

function extractCommitMessage(text: string): string {
  let message = text.trim()
  
  message = message.replace(/^(Here's|Here is|The commit message is|Commit message:)\s*/i, '')
  
  message = message.replace(/^["'`]|["'`]$/g, '')
  
  const lines = message.split('\n')
  const firstLine = lines[0].trim()
  
  if (firstLine.length > 100) {
    return firstLine.slice(0, 100).trim()
  }
  
  return firstLine || message.slice(0, 100)
}

function generateFallbackMessage(diffContent: string): string {
  const lines = diffContent.split('\n')
  const fileChanges: { path: string; type: string }[] = []

  for (const line of lines) {
    const match = line.match(/File: (.+?) \((\w+)\)/)
    if (match) {
      fileChanges.push({ path: match[1], type: match[2] })
    }
  }

  if (fileChanges.length === 0) {
    return 'chore: update files'
  }

  const types = new Set(fileChanges.map((f) => f.type))
  const files = fileChanges.map((f) => f.path)

  if (types.has('added')) {
    return `feat: add ${files.length === 1 ? files[0] : `${files.length} files`}`
  }
  if (types.has('deleted')) {
    return `chore: remove ${files.length === 1 ? files[0] : `${files.length} files`}`
  }
  if (types.has('renamed')) {
    return `refactor: rename ${files.length === 1 ? files[0] : `${files.length} files`}`
  }

  return `chore: update ${files.length === 1 ? files[0] : `${files.length} files`}`
}
