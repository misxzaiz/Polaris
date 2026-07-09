/**
 * 引擎 × 会话配置选择器 能力矩阵
 *
 * 单一事实源：声明每个引擎实际「会被后端消费」的配置选择器。
 * UI（ChatStatusBar / SessionConfigSelector）据此裁剪展示，避免向用户展示
 * 对当前引擎无效、甚至会导致后端报错的选择器。
 *
 * 矩阵依据后端实际命令构建逻辑（src-tauri/src/ai/engine/*.rs + commands/chat.rs）：
 *
 * | 选择器     | claude-code | codex | simple-ai | mimo |
 * |-----------|:-----------:|:-----:|:---------:|:----:|
 * | agent     | ✅ --agent  | ❌    | ❌        | ❌   |
 * | model     | ✅ 别名     | ✅    | ✅(用profile.model) | ✅ provider/model |
 * | effort    | ✅          | ❌    | ❌        | ❌   |
 * | permission| ✅          | ✅    | ❌        | ✅(仅bypass) |
 * | profile   | ✅          | ✅    | ✅(必需)  | ❌(内置认证,选了会报 incompatibleRuntime) |
 *
 * 说明：
 * - codex 后端 build_command 不接收 agent / effort，展示它们只会误导用户。
 * - simple-ai 的 model 选择器由所选 Profile 的 modelOptions 驱动（commands/chat.rs
 *   apply_model_profile_options 优先使用前端 selected_model），agent/effort/permission
 *   由文件系统与自定义配置驱动，不暴露。
 * - mimo 使用内置认证，profile 不仅无效，且 targetEngine 不匹配时后端会中断请求
 *   （见 commands/chat.rs apply_model_profile_options 的 incompatibleRuntime 分支）。
 */

import { normalizeEngineId } from './engineDisplay'

/** 会话配置选择器类型（与 SessionConfigSelector / ChatStatusBar 保持一致） */
export type SelectorType = 'agent' | 'model' | 'effort' | 'permission' | 'profile'

/**
 * 引擎 → 可展示的选择器列表。
 *
 * 用 `Record<string, ...>` 而非 `Record<EngineId, ...>`：项目存在两个 EngineId 定义
 * （types/session.ts 无 mimo、types/config.ts 有 mimo），以归一化后的字符串为键可规避
 * 「双 EngineId 同步陷阱」。键与 normalizeEngineId 的返回值对齐。
 */
const ENGINE_SELECTOR_CAPABILITIES: Record<string, SelectorType[]> = {
  'claude-code': ['agent', 'model', 'effort', 'permission', 'profile'],
  codex: ['model', 'permission', 'profile'],
  'simple-ai': ['model', 'profile'],
  mimo: ['model', 'permission'],
}

/** 获取指定引擎可展示的选择器列表（未知引擎降级为 claude-code） */
export function getEngineSelectors(engineId?: string | null): SelectorType[] {
  const id = normalizeEngineId(engineId)
  return ENGINE_SELECTOR_CAPABILITIES[id] ?? ENGINE_SELECTOR_CAPABILITIES['claude-code']
}

/** 判断某选择器是否适用于指定引擎 */
export function isSelectorSupported(engineId: string | null | undefined, type: SelectorType): boolean {
  return getEngineSelectors(engineId).includes(type)
}
