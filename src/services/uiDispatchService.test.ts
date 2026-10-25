/**
 * uiDispatchService 单元测试：cap.ui 动作 → store 映射逻辑。
 *
 * mock 掉 themeStore / configStore，聚焦纯映射：
 * - cap.ui.theme: patch 语义色克隆主题 / applyPreset 切内置 / setActive 切换 / import
 * - cap.ui.chat: patch 合并到 chatDisplay / reset 清空
 * - consumeCapUiDispatch: 非 cap.ui target 不消费，缺 action 有兜底
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- mock stores（避免 localStorage 污染与 store 依赖） ----
// themes: active-1(内置) / user-1(用户)
const saveThemeMock = vi.fn()
const setThemeByIdMock = vi.fn()
const deleteThemeMock = vi.fn()
const updateConfigPatchMock = vi.fn()

vi.mock('@/stores/themeStore', () => ({
  useThemeStore: {
    getState: () => ({
      activeThemeId: 'active-1',
      activeTheme: mockTheme(),
      themes: [
        { id: 'active-1', name: '当前', builtIn: true },
        { id: 'user-1', name: '用户主题', builtIn: false },
      ],
      saveTheme: saveThemeMock,
      setThemeById: setThemeByIdMock,
      deleteTheme: deleteThemeMock,
    }),
  },
}))

vi.mock('@/stores/configStore', () => ({
  useConfigStore: {
    getState: () => ({
      // uiControlEnabled: true —— 消费口门控开启（门控行为由专门用例覆盖）
      config: { chatDisplay: { fontSize: 14, messageSpacing: 'comfortable' }, uiControlEnabled: true },
      updateConfigPatch: updateConfigPatchMock,
    }),
  },
}))

import { applyUiThemeAction, applyUiChatAction, consumeCapUiDispatch } from '@/services/uiDispatchService'

function mockTheme() {
  return {
    id: 'active-1',
    name: '当前',
    version: 1,
    builtIn: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    colors: {
      primary: { base: '#111', hover: '#222', '50': '#eee', '100': '#ddd', '200': '#ccc', '300': '#bbb', '400': '#aaa', '500': '#999', '600': '#888', '700': '#777' },
      background: { base: '#000', elevated: '#111', surface: '#222', hover: '#333', active: '#444', tertiary: '#555', secondary: '#666' },
      border: { base: '#777' },
      text: { primary: '#fff', secondary: '#eee', tertiary: '#ddd', muted: '#ccc' },
      status: { warning: '#f00', success: '#0f0', danger: '#00f', info: '#0ff', done: '#ff0', failed: '#f0f', neutral: '#aaa' },
      priority: { low: '#111', normal: '#222', high: '#333', urgent: '#444' },
      accent: { ai: '#555', prototype: '#666', workspace: '#777' },
      misc: { overlay: '#000', onPrimary: '#fff', canvas: '#000', tagBg: '#111', shadow: '#000' },
    },
    typography: { fontSans: 'sans', fontMono: 'mono', fontSizeBase: '14px', fontWeightNormal: '400', fontWeightMedium: '500', fontWeightSemibold: '600', letterSpacing: '0', chatFontSize: 14, chatLineHeight: 1.5, chatCodeFontSize: 13, chatInputFontSize: 14 },
    shape: { radiusSm: '4px', radiusMd: '8px', radiusLg: '12px', radiusXl: '16px', radiusFull: '999px', chatBubbleRadius: '12px', borderWidth: '1px', borderStyle: 'solid', chatBubblePaddingX: '12px', chatBubblePaddingY: '8px' },
    layout: { sidebarWidth: '260px' },
  }
}

describe('applyUiThemeAction', () => {
  beforeEach(() => {
    saveThemeMock.mockClear()
    setThemeByIdMock.mockClear()
    deleteThemeMock.mockClear()
  })

  it('patch: 语义色映射为 colors 深层路径，克隆新主题并激活', () => {
    const res = applyUiThemeAction('patch', {
      palette: { 'primary.base': '#abcdef', 'text.muted': '#888' },
    })
    expect(res.ok).toBe(true)
    // 保存的是新克隆主题（builtIn 被翻转）
    const saved = saveThemeMock.mock.calls[0][0]
    expect(saved.builtIn).toBe(false)
    expect(saved.id).not.toBe('active-1')
    expect(saved.colors.primary.base).toBe('#abcdef')
    expect(saved.colors.text.muted).toBe('#888')
    // 克隆后再激活
    expect(setThemeByIdMock).toHaveBeenCalledWith(saved.id)
  })

  it('patch: 未知语义键完全忽略返回失败', () => {
    const res = applyUiThemeAction('patch', { palette: { 'unknown.key': '#ff0' } })
    expect(res.ok).toBe(false) // 无可用语义键 → 不写也不激活
    expect(saveThemeMock).not.toHaveBeenCalled()
  })

  it('patch: 无有效语义键返回失败', () => {
    const res = applyUiThemeAction('patch', { palette: { 'evil': '#000' } })
    expect(res.ok).toBe(false)
    expect(saveThemeMock).not.toHaveBeenCalled()
  })

  it('applyPreset: dark/light 映射内置 id 并激活', () => {
    const res = applyUiThemeAction('applyPreset', { preset: 'dark' })
    expect(res.ok).toBe(true)
    expect(setThemeByIdMock).toHaveBeenCalledWith('00000000-0000-0000-0000-000000000001')
  })

  it('applyPreset: 未知 preset 返回失败', () => {
    const res = applyUiThemeAction('applyPreset', { preset: 'neon' })
    expect(res.ok).toBe(false)
  })

  it('setActive: 已存在主题切换成功', () => {
    const res = applyUiThemeAction('setActive', { id: 'user-1' })
    expect(res.ok).toBe(true)
    expect(setThemeByIdMock).toHaveBeenCalledWith('user-1')
  })

  it('setActive: 不存在主题返回失败', () => {
    const res = applyUiThemeAction('setActive', { id: 'nope' })
    expect(res.ok).toBe(false)
  })

  it('get: 返回当前激活主题 id', () => {
    const res = applyUiThemeAction('get', {})
    expect(res.ok).toBe(true)
    expect(res.message).toContain('active-1')
  })

  it('listThemes: 列出主题摘要（不含完整定义）', () => {
    const res = applyUiThemeAction('listThemes', {})
    expect(res.ok).toBe(true)
    expect(res.message).toContain('当前')
    expect(res.message).toContain('用户主题')
  })

  it('export: 序列化当前激活主题完整定义', () => {
    const res = applyUiThemeAction('export', {})
    expect(res.ok).toBe(true)
    const parsed = JSON.parse(res.message)
    expect(parsed.id).toBe('active-1')
    expect(parsed.colors.primary.base).toBe('#111')
  })

  it('import: 导入主题为新用户主题并激活', () => {
    const res = applyUiThemeAction('import', {
      theme: { name: 'AI 导入', colors: { primary: { base: '#0f0' } } },
    })
    expect(res.ok).toBe(true)
    const saved = saveThemeMock.mock.calls[0][0]
    expect(saved.builtIn).toBe(false)
    expect(saved.name).toBe('AI 导入')
    expect(saved.colors.primary.base).toBe('#0f0')
    expect(setThemeByIdMock).toHaveBeenCalledWith(saved.id)
  })

  it('import: 缺 theme 对象返回失败', () => {
    const res = applyUiThemeAction('import', {})
    expect(res.ok).toBe(false)
    expect(saveThemeMock).not.toHaveBeenCalled()
  })

  it('import: 残缺 theme 经 mergeThemes 归一后保存（缺省字段补全）', () => {
    const res = applyUiThemeAction('import', {
      // 只给部分字段：colors 仅 primary.base，typography/shape 缺失
      theme: { name: '极简', colors: { primary: { base: '#0f0' } } },
    })
    expect(res.ok).toBe(true)
    const saved = saveThemeMock.mock.calls[0][0]
    // 缺省维度被 Dark 兜底补全（归一后是完整主题，注入层可安全裸解构）
    expect(saved.colors.text.primary).toBeTruthy()
    expect(saved.typography.fontSans).toBeTruthy()
    expect(saved.shape.radiusSm).toBeTruthy()
    // 已给字段保留
    expect(saved.colors.primary.base).toBe('#0f0')
    expect(saved.builtIn).toBe(false)
    expect(setThemeByIdMock).toHaveBeenCalledWith(saved.id)
  })

  it('import: 无名主题回退为未命名主题', () => {
    const res = applyUiThemeAction('import', { theme: { colors: {} } })
    expect(res.ok).toBe(true)
    expect(saveThemeMock.mock.calls[0][0].name).toBe('未命名主题')
  })

  it('delete: 用户主题删除成功', () => {
    const res = applyUiThemeAction('delete', { id: 'user-1' })
    expect(res.ok).toBe(true)
    expect(deleteThemeMock).toHaveBeenCalledWith('user-1')
  })

  it('delete: 内置主题拒绝', () => {
    const res = applyUiThemeAction('delete', { id: 'active-1' })
    expect(res.ok).toBe(false)
    expect(deleteThemeMock).not.toHaveBeenCalled()
  })

  it('delete: 不存在或缺少 id 拒绝', () => {
    expect(applyUiThemeAction('delete', { id: 'nope' }).ok).toBe(false)
    expect(applyUiThemeAction('delete', {}).ok).toBe(false)
    expect(deleteThemeMock).not.toHaveBeenCalled()
  })
})

describe('applyUiChatAction', () => {
  it('patch: 合并到现有 chatDisplay', () => {
    const res = applyUiChatAction('patch', { config: { fontSize: 18, messageSpacing: 'spacious' } })
    expect(res.ok).toBe(true)
    const patch = updateConfigPatchMock.mock.calls[0][0]
    expect(patch.chatDisplay.fontSize).toBe(18)
    expect(patch.chatDisplay.messageSpacing).toBe('spacious')
    expect(patch.chatDisplay.lineHeight).toBe(undefined) // 不丢旧字段合并场景不用断言过细
  })

  it('reset: 清空 chatDisplay', () => {
    const res = applyUiChatAction('reset', {})
    expect(res.ok).toBe(true)
    expect(updateConfigPatchMock).toHaveBeenCalledWith({ chatDisplay: null })
  })
})

describe('consumeCapUiDispatch', () => {
  beforeEach(() => {
    saveThemeMock.mockClear()
    setThemeByIdMock.mockClear()
    deleteThemeMock.mockClear()
    updateConfigPatchMock.mockClear()
  })

  it('非 cap.ui target 不消费', () => {
    const res = consumeCapUiDispatch({ target: 'cap.todo', payload: { action: 'list' } })
    expect(res.consumed).toBe(false)
  })

  it('cap.ui.theme 命中并应用', () => {
    const res = consumeCapUiDispatch({
      target: 'cap.ui.theme',
      payload: { action: 'applyPreset', preset: 'light' },
    })
    expect(res.consumed).toBe(true)
    expect(setThemeByIdMock).toHaveBeenCalledWith('00000000-0000-0000-0000-000000000002')
  })

  it('cap.ui.chat 命中并应用', () => {
    const res = consumeCapUiDispatch({
      target: 'cap.ui.chat',
      payload: { action: 'patch', config: { fontSize: 20 } },
    })
    expect(res.consumed).toBe(true)
    const patch = updateConfigPatchMock.mock.calls[0][0]
    expect(patch.chatDisplay.fontSize).toBe(20)
  })

  it('缺 action 有兜底消息', () => {
    const res = consumeCapUiDispatch({ target: 'cap.ui.theme', payload: {} })
    expect(res.consumed).toBe(true)
    expect(res.message).toContain('缺 action')
  })

  it('uiControlEnabled 关闭时不消费（AI 界面控制未开启）', async () => {
    const configStore = (await import('@/stores/configStore')).useConfigStore
    const original = configStore.getState
    ;(configStore as { getState: () => unknown }).getState = () => ({
      config: { uiControlEnabled: false },
      updateConfigPatch: updateConfigPatchMock,
    })
    try {
      const res = consumeCapUiDispatch({
        target: 'cap.ui.theme',
        payload: { action: 'applyPreset', preset: 'dark' },
      })
      expect(res.consumed).toBe(false)
      expect(setThemeByIdMock).not.toHaveBeenCalled()
    } finally {
      ;(configStore as { getState: () => unknown }).getState = original
    }
  })

  it('args 为空不消费', () => {
    expect(consumeCapUiDispatch(undefined).consumed).toBe(false)
    expect(consumeCapUiDispatch({} as Record<string, unknown>).consumed).toBe(false)
  })
})