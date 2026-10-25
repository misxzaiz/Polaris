/**
 * 主题宿主 API — 暴露给外部插件面板的委托通道
 *
 * 挂载在 window.__POLARIS_THEME_API__（main.tsx 初始化）。
 * 主题状态真相在前端 themeStore（localStorage 同步缓存 + DataRoot 跨端镜像，
 * 见 themeService 头注释）；插件面板不旁路读 localStorage / 直写 CSS 变量，
 * 而是经本 API 委托 themeStore 执行所有变更：
 *   - 写路径：插件 → 本 API → themeStore action → localStorage 缓存 + DataRoot
 *     推送 + config 持久化（activeThemeId）+ DOM 注入，全 UI 响应式刷新天然成立。
 *   - 读路径：list/get/template 直接读 store 内存态（零 IPC）；完整 88 维
 *     ThemeDefinition 可经 template() 取得（作为生成模板，无需复制 schema）。
 *
 * 安全边界：与 __POLARIS_WORKSPACE_API__ 同级——仅存在于主应用 window，
 * 插件面板与宿主同 window 运行；主题为 L0 低危展示域（插件可覆盖 cap.ui.*）。
 */

import { useThemeStore } from '@/stores/themeStore'
import type { ThemeDefinition } from '@/types/theme'

export interface HostThemeSummary {
  id: string
  name: string
  builtIn: boolean
  description?: string
  updatedAt?: string
}

export interface HostThemeApi {
  /** 主题列表摘要（内置 + 用户；store 内存态） */
  list(): HostThemeSummary[]
  /** 当前激活主题 id */
  activeId(): string
  /** 完整主题定义（含全部维度）；内置或不存在返回 null */
  get(id: string): ThemeDefinition | null
  /** 以当前激活主题为模板返回完整 ThemeDefinition（生成新主题的起点，含 88 维全字段） */
  template(): ThemeDefinition
  /** 保存/更新用户主题（归一 + localStorage + DataRoot 推送；内置主题将被拒绝克隆为自定义） */
  save(theme: ThemeDefinition): void
  /** 删除用户主题（内置不可删；删除激活主题时前端自动回退 Dark） */
  remove(id: string): boolean
  /** 切换激活主题（含 config 持久化，跨端启动回放） */
  apply(id: string): Promise<void>
  /** 订阅主题列表/激活态变化。返回取消订阅函数 */
  subscribe(listener: () => void): () => void
  /** 与 DataRoot 对账（拉取其他端新增/更新的主题） */
  syncFromRemote(): Promise<void>
}

/** 创建并返回主题宿主 API 实例（main.tsx 挂载到 window） */
export function createHostThemeApi(): HostThemeApi {
  return {
    list: () => {
      const { themes } = useThemeStore.getState()
      return themes.map((t) => ({
        id: t.id,
        name: t.name,
        builtIn: !!t.builtIn,
        description: t.description,
        updatedAt: t.updatedAt,
      }))
    },
    activeId: () => useThemeStore.getState().activeThemeId,
    get: (id) => {
      const t = useThemeStore.getState().themes.find((x) => x.id === id)
      return t ?? null
    },
    template: () => {
      const s = useThemeStore.getState()
      return s.activeTheme ?? s.themes.find((t) => t.builtIn) ?? s.themes[0]
    },
    save: (theme) => useThemeStore.getState().saveTheme(theme),
    remove: (id) => useThemeStore.getState().deleteTheme(id),
    apply: (id) => useThemeStore.getState().setThemeById(id),
    subscribe(listener) {
      const unsub = useThemeStore.subscribe(listener)
      listener()
      return unsub
    },
    syncFromRemote: () => useThemeStore.getState().syncFromRemote(),
  }
}
