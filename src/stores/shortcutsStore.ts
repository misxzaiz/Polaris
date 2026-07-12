/**
 * 快捷键注册中心
 *
 * 集中管理所有全局快捷键定义，提供查询接口。
 * 当前阶段：只读展示（查看所有快捷键）。
 * 后续阶段：支持自定义修改、导入导出、冲突检测。
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// ─── 快捷键分类 ───────────────────────────────────────────

export type ShortcutCategory =
  | 'global'
  | 'editor'
  | 'lsp'
  | 'chat'
  | 'fileExplorer'
  | 'diff'
  | 'terminal'
  | 'voice'

// ─── 单条快捷键定义 ───────────────────────────────────────

export interface ShortcutDefinition {
  /** 唯一标识 */
  id: string
  /** 分类 */
  category: ShortcutCategory
  /** 显示名称（中文） */
  label: string
  /** 显示名称（英文） */
  labelEn: string
  /** 描述（中文） */
  description?: string
  /** 描述（英文） */
  descriptionEn?: string
  /** 按键组合，如 "Ctrl+Shift+R"、"Mod-s" */
  keys: string
  /** CodeMirror 格式的原始键位（仅编辑器快捷键） */
  cmKey?: string
  /** 是否仅桌面端可用 */
  desktopOnly?: boolean
  /** 是否可自定义（预留） */
  customizable?: boolean
  /** 是否禁用（预留） */
  disabled?: boolean
}

// ─── 分类元信息 ───────────────────────────────────────────

export interface ShortcutCategoryMeta {
  id: ShortcutCategory
  label: string
  labelEn: string
  icon: string
  order: number
}

export const CATEGORY_META: Record<ShortcutCategory, ShortcutCategoryMeta> = {
  global:        { id: 'global',        label: '全局',     labelEn: 'Global',        icon: '🌐', order: 0 },
  editor:        { id: 'editor',        label: '编辑器',   labelEn: 'Editor',        icon: '📝', order: 1 },
  lsp:           { id: 'lsp',           label: '语言服务', labelEn: 'Language Server', icon: '🔧', order: 2 },
  chat:          { id: 'chat',          label: '对话',     labelEn: 'Chat',          icon: '💬', order: 3 },
  fileExplorer:  { id: 'fileExplorer',  label: '文件浏览', labelEn: 'File Explorer', icon: '📁', order: 4 },
  diff:          { id: 'diff',          label: '差异对比', labelEn: 'Diff View',     icon: '🔀', order: 5 },
  terminal:      { id: 'terminal',      label: '终端',     labelEn: 'Terminal',      icon: '🖥️', order: 6 },
  voice:         { id: 'voice',         label: '语音伙伴', labelEn: 'Voice Companion', icon: '🎙️', order: 7 },
}

// ─── 快捷键注册表（静态数据） ─────────────────────────────

function getRegistry(): ShortcutDefinition[] {
  const isMac = navigator.platform.includes('Mac')
  const mod = isMac ? '⌘' : 'Ctrl'

  return [
    // ── 全局 ──
    {
      id: 'global.devtools',
      category: 'global',
      label: '切换开发者工具',
      labelEn: 'Toggle DevTools',
      description: '打开/关闭浏览器开发者工具',
      descriptionEn: 'Open/close browser DevTools',
      keys: 'F12',
      desktopOnly: true,
    },
    {
      id: 'global.fileSearch',
      category: 'global',
      label: '文件搜索 / 快速运行',
      labelEn: 'File Search / Quick Run',
      description: '打开文件搜索面板；终端模式下打开快速运行',
      descriptionEn: 'Open file search; in terminal mode, open quick run',
      keys: `${mod}+Shift+R`,
    },
    {
      id: 'global.newSession',
      category: 'global',
      label: '新建会话',
      labelEn: 'New Session',
      description: '快速新建 AI 对话会话并聚焦输入框',
      descriptionEn: 'Quickly create a new AI session and focus input',
      keys: `${mod}++`,
    },
    {
      id: 'global.newSessionWithWorkspace',
      category: 'global',
      label: '选择工作区新建会话',
      labelEn: 'New Session with Workspace',
      description: '弹出工作区选择面板后新建会话',
      descriptionEn: 'Open workspace picker then create session',
      keys: `${mod}+Shift++`,
    },

    // ── 编辑器 ──
    {
      id: 'editor.save',
      category: 'editor',
      label: '保存文件',
      labelEn: 'Save File',
      description: '保存当前文件，若开启自动格式化则先格式化',
      descriptionEn: 'Save current file, format first if enabled',
      keys: `${mod}+S`,
      cmKey: 'Mod-s',
    },
    {
      id: 'editor.gotoLine',
      category: 'editor',
      label: '跳转到行',
      labelEn: 'Go to Line',
      description: '打开行号跳转输入框',
      descriptionEn: 'Open line number input',
      keys: `${mod}+G`,
      cmKey: 'Mod-g',
    },
    {
      id: 'editor.increaseFont',
      category: 'editor',
      label: '增大字体',
      labelEn: 'Increase Font Size',
      keys: `${mod}+=`,
      cmKey: 'Mod-=',
    },
    {
      id: 'editor.decreaseFont',
      category: 'editor',
      label: '减小字体',
      labelEn: 'Decrease Font Size',
      keys: `${mod}+-`,
      cmKey: 'Mod--',
    },
    {
      id: 'editor.resetFont',
      category: 'editor',
      label: '重置字体大小',
      labelEn: 'Reset Font Size',
      keys: `${mod}+0`,
      cmKey: 'Mod-0',
    },
    {
      id: 'editor.cursorAbove',
      category: 'editor',
      label: '上方添加光标',
      labelEn: 'Add Cursor Above',
      description: '多光标：在当前光标上方添加新光标',
      descriptionEn: 'Multi-cursor: add cursor above',
      keys: 'Alt+↑',
      cmKey: 'Alt-ArrowUp',
    },
    {
      id: 'editor.cursorBelow',
      category: 'editor',
      label: '下方添加光标',
      labelEn: 'Add Cursor Below',
      description: '多光标：在当前光标下方添加新光标',
      descriptionEn: 'Multi-cursor: add cursor below',
      keys: 'Alt+↓',
      cmKey: 'Alt-ArrowDown',
    },
    {
      id: 'editor.search',
      category: 'editor',
      label: '搜索',
      labelEn: 'Search',
      description: '在编辑器中搜索文本',
      descriptionEn: 'Search text in editor',
      keys: `${mod}+F`,
      cmKey: 'Mod-f',
    },
    {
      id: 'editor.undo',
      category: 'editor',
      label: '撤销',
      labelEn: 'Undo',
      keys: `${mod}+Z`,
      cmKey: 'Mod-z',
    },
    {
      id: 'editor.redo',
      category: 'editor',
      label: '重做',
      labelEn: 'Redo',
      keys: isMac ? `${mod}+Shift+Z` : `${mod}+Y`,
      cmKey: isMac ? 'Mod-Shift-z' : 'Mod-y',
    },

    // ── 语言服务 ──
    {
      id: 'lsp.definition',
      category: 'lsp',
      label: '跳转定义',
      labelEn: 'Go to Definition',
      description: '跳转到符号定义处',
      descriptionEn: 'Jump to symbol definition',
      keys: `${mod}+Alt+B`,
      cmKey: 'Mod-Alt-b',
      customizable: true,
    },
    {
      id: 'lsp.references',
      category: 'lsp',
      label: '查找引用',
      labelEn: 'Find References',
      description: '查找符号的所有引用位置',
      descriptionEn: 'Find all references to a symbol',
      keys: 'Alt+Shift+R',
      cmKey: 'Alt-Shift-r',
      customizable: true,
    },
    {
      id: 'lsp.symbolPalette',
      category: 'lsp',
      label: '文档符号面板',
      labelEn: 'Document Symbols',
      description: '打开当前文件的符号列表',
      descriptionEn: 'Open symbol list for current file',
      keys: `${mod}+Shift+O`,
      cmKey: 'Mod-Shift-o',
    },
    {
      id: 'lsp.ctrlClick',
      category: 'lsp',
      label: 'Ctrl+Click 跳转定义',
      labelEn: 'Ctrl+Click Jump to Definition',
      description: '按住 Ctrl/Cmd 点击符号跳转到定义',
      descriptionEn: 'Hold Ctrl/Cmd and click symbol to jump to definition',
      keys: `${mod}+Click`,
    },

    // ── 对话 ──
    {
      id: 'chat.search',
      category: 'chat',
      label: '搜索消息',
      labelEn: 'Search Messages',
      description: '在当前会话中搜索消息内容',
      descriptionEn: 'Search messages in current session',
      keys: `${mod}+F`,
    },

    // ── 文件浏览 ──
    {
      id: 'fileExplorer.refresh',
      category: 'fileExplorer',
      label: '刷新目录',
      labelEn: 'Refresh Directory',
      description: '刷新文件浏览器的目录列表',
      descriptionEn: 'Refresh file explorer directory listing',
      keys: 'F5',
    },

    // ── 差异对比 ──
    {
      id: 'diff.nextChange',
      category: 'diff',
      label: '下一个变更',
      labelEn: 'Next Change',
      keys: 'J',
    },
    {
      id: 'diff.prevChange',
      category: 'diff',
      label: '上一个变更',
      labelEn: 'Previous Change',
      keys: 'K',
    },
    {
      id: 'diff.nextFile',
      category: 'diff',
      label: '下一个文件',
      labelEn: 'Next File',
      keys: ']',
    },
    {
      id: 'diff.prevFile',
      category: 'diff',
      label: '上一个文件',
      labelEn: 'Previous File',
      keys: '[',
    },
    {
      id: 'diff.openFile',
      category: 'diff',
      label: '打开文件编辑',
      labelEn: 'Open File Editor',
      keys: 'Enter',
    },
    {
      id: 'diff.close',
      category: 'diff',
      label: '关闭差异视图',
      labelEn: 'Close Diff View',
      keys: 'Esc',
    },

    // ── 终端 ──
    {
      id: 'terminal.exitFullscreen',
      category: 'terminal',
      label: '退出终端全屏',
      labelEn: 'Exit Terminal Fullscreen',
      description: '退出终端的全屏模式',
      descriptionEn: 'Exit terminal fullscreen mode',
      keys: 'Esc',
    },

    // ── 语音伙伴 ──
    {
      id: 'voice.hangup',
      category: 'voice',
      label: '挂断通话',
      labelEn: 'Hang Up',
      description: '结束语音伙伴通话',
      descriptionEn: 'End voice companion call',
      keys: 'Esc',
    },
    {
      id: 'voice.toggle',
      category: 'voice',
      label: '切换语音状态',
      labelEn: 'Toggle Voice State',
      description: '非监听状态下按空格切换',
      descriptionEn: 'Toggle when not listening',
      keys: 'Space',
    },
  ]
}

// ─── Store ────────────────────────────────────────────────

interface ShortcutsState {
  /** 所有已注册快捷键（运行时生成） */
  shortcuts: ShortcutDefinition[]
  /** 当前语言：'zh-CN' | 'en-US' */
  locale: string
}

interface ShortcutsActions {
  /** 刷新注册表（平台相关快捷键可能变化） */
  refresh: () => void
  /** 设置语言 */
  setLocale: (locale: string) => void
  /** 按分类获取快捷键 */
  getByCategory: (category: ShortcutCategory) => ShortcutDefinition[]
  /** 搜索快捷键 */
  search: (query: string) => ShortcutDefinition[]
}

export const useShortcutsStore = create<ShortcutsState & ShortcutsActions>()(
  persist(
    (set, get) => ({
      shortcuts: [],
      locale: 'zh-CN',

      refresh: () => {
        set({ shortcuts: getRegistry() })
      },

      setLocale: (locale: string) => {
        set({ locale })
      },

      getByCategory: (category: ShortcutCategory) => {
        return get().shortcuts.filter(s => s.category === category)
      },

      search: (query: string) => {
        const q = query.toLowerCase()
        return get().shortcuts.filter(s => {
          return (
            s.label.toLowerCase().includes(q) ||
            s.labelEn.toLowerCase().includes(q) ||
            (s.description ?? '').toLowerCase().includes(q) ||
            (s.descriptionEn ?? '').toLowerCase().includes(q) ||
            s.keys.toLowerCase().includes(q) ||
            s.id.toLowerCase().includes(q)
          )
        })
      },
    }),
    {
      name: 'shortcuts-settings',
      partialize: (state) => ({ locale: state.locale }),
    }
  )
)

// ─── 格式化工具 ───────────────────────────────────────────

/** 将 Mod 转为平台对应的修饰键符号 */
export function formatKeyForDisplay(key: string): string {
  const isMac = navigator.platform.includes('Mac')
  return key
    .replace(/^Mod-/g, isMac ? '⌘' : 'Ctrl+')
    .replace(/-Mod/g, isMac ? '+⌘' : '+Ctrl')
    .replace(/-/g, '+')
}

/** 获取当前平台的 Mod 前缀 */
export function getModPrefix(): string {
  return navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'
}
