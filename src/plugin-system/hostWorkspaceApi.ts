/**
 * 工作区宿主 API — 暴露给外部插件面板的委托通道
 *
 * 挂载在 window.__POLARIS_WORKSPACE_API__（main.tsx 初始化）。
 * 外部插件面板（如 workspace-manager）不直接写 config.json，而是通过本 API
 * 委托主应用 workspaceStore 执行所有变更：
 *   - 写路径：插件 → 本 API → workspaceStore action → persistToServer → 后端 config.json
 *     workspaceStore 自带 set_work_dir / 事件派发 / 全 UI 响应式刷新，
 *     因此"主应用工作区绑定更新"天然成立，无需额外同步代码。
 *   - 读路径：插件经 window.__POLARIS_HOST_INVOKE__ 调 get_config 自行读取，
 *     或直接读取本 API 的 list() 快照（走主应用 store 内存态，零 IPC）。
 *
 * 安全边界：本 API 仅在主应用 window 上存在；插件面板与宿主同 window 运行。
 * 是否暴露给某插件由 manifest permissions（workspaceRead/workspaceWrite）约束，
 * 后端 plugin_get_config / plugin_set_config 已做权限校验，前端通道不绕过后端写。
 */

import { useWorkspaceStore } from '@/stores/workspaceStore'

export interface HostWorkspace {
  id: string
  name: string
  path: string
  createdAt: string
  lastAccessed: string
}

export interface HostWorkspaceApi {
  /** 工作区列表快照（主应用 store 内存态） */
  list(): HostWorkspace[]
  /** 当前工作区 id */
  currentId(): string | null
  /** 订阅工作区变更（列表/当前项任一变化）。返回取消订阅函数 */
  subscribe(listener: () => void): () => void
  /** 切换工作区（委托 switchWorkspace：set_work_dir + 事件 + 持久化） */
  switch(id: string): Promise<void>
  /** 新建工作区（委托 createWorkspace：校验 + 持久化 + 可选切换） */
  create(name: string, path: string, switchAfter?: boolean): Promise<HostWorkspace>
  /** 重命名/更新（委托 updateWorkspace） */
  update(id: string, updates: { name?: string; path?: string }): Promise<void>
  /** 删除（委托 deleteWorkspace：保底 1 个 + 联动切换） */
  remove(id: string): Promise<void>
  /** 校验路径是否为有效工作区目录 */
  validatePath(path: string): Promise<boolean>
}

function toHost(w: { id: string; name: string; path: string; createdAt: string; lastAccessed: string }): HostWorkspace {
  return { id: w.id, name: w.name, path: w.path, createdAt: w.createdAt, lastAccessed: w.lastAccessed }
}

/** 创建并返回工作区宿主 API 实例（main.tsx 挂载到 window） */
export function createHostWorkspaceApi(): HostWorkspaceApi {
  return {
    list: () => useWorkspaceStore.getState().workspaces.map(toHost),
    currentId: () => useWorkspaceStore.getState().currentWorkspaceId,
    subscribe(listener: () => void) {
      const unsub = useWorkspaceStore.subscribe(listener)
      // 挂载时立即回调一次，让插件面板拿到初始数据
      listener()
      return unsub
    },
    switch: (id) => useWorkspaceStore.getState().switchWorkspace(id),
    create: async (name, path, switchAfter = true) => {
      await useWorkspaceStore.getState().createWorkspace(name, path, switchAfter)
      const created = useWorkspaceStore.getState().workspaces.find((w) => w.path === path)
      if (!created) throw new Error('创建后未找到对应工作区')
      return toHost(created)
    },
    update: (id, updates) => useWorkspaceStore.getState().updateWorkspace(id, updates),
    remove: (id) => useWorkspaceStore.getState().deleteWorkspace(id),
    validatePath: (path) => useWorkspaceStore.getState().validateWorkspacePath(path),
  }
}
