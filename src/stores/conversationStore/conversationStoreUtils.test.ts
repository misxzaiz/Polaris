import { describe, it, expect } from 'vitest'
import {
  resolveEffectiveProfileId,
  resolveEffectiveProfileMode,
  isProfileModeWithoutProfile,
} from './conversationStoreUtils'
import {
  OFFICIAL_API_PROFILE,
  profileModelOptions,
  normalizeModelForProfile,
} from '@/types/modelProfile'

/**
 * Profile 模型归一化：
 * `model` 与 `modelProfileId` 是两个独立持久化字段。用户从官方 API 切到第三方
 * Profile 时，`config.model` 可能残留 Claude CLI 官方别名（opus/sonnet/haiku），
 * 而别名只有官方端点认——第三方端点直接返回
 * `{"type":"invalid_request_error","message":"unknown provider for model opus"}`。
 * 发送前必须校验「选的模型」是否属于「选的 Profile」，不属于就清空（后端会回退
 * profile.model 默认，请求仍可发出）。
 */
describe('profileModelOptions', () => {
  it('modelOptions 有值时优先使用', () => {
    expect(profileModelOptions({ model: 'a', modelOptions: ['a', 'b'] })).toEqual(['a', 'b'])
  })

  it('modelOptions 为空/未设置时回退到 [model]（与 UI 下拉构造口径一致）', () => {
    expect(profileModelOptions({ model: 'agnes-2.5-flash', modelOptions: [] })).toEqual([
      'agnes-2.5-flash',
    ])
    expect(profileModelOptions({ model: 'agnes-2.5-flash' })).toEqual(['agnes-2.5-flash'])
  })

  it('过滤空串', () => {
    expect(profileModelOptions({ model: 'a', modelOptions: ['a', '', 'b', ''] })).toEqual(['a', 'b'])
    // 回退口径：model 本身为空时也不产出空串
    expect(profileModelOptions({ model: '' })).toEqual([])
  })

  it('保留带空白的条目（不 trim，与 modelList 的 filter(Boolean) 口径一致）', () => {
    expect(profileModelOptions({ model: 'a', modelOptions: ['b '] })).toEqual(['b '])
  })
})

describe('normalizeModelForProfile', () => {
  const thirdParty = {
    model: 'deepseek-v4-flash',
    modelOptions: [
      'deepseek-v4-flash',
      'agnes-2.5-flash[1m]',
      'claude-fable-5-dd-orp-5.2-senga',
    ],
  }

  // ===== 无 Profile（官方 API / 分组路由 / 未选）：别名合法，原样透传 =====

  it('profile 为 null/undefined 时模型原样透传（官方端点认 opus）', () => {
    expect(normalizeModelForProfile('opus', undefined)).toBe('opus')
    expect(normalizeModelForProfile('opus', null)).toBe('opus')
    expect(normalizeModelForProfile('claude-opus-4-8', null)).toBe('claude-opus-4-8')
  })

  it('profile 存在但模型为空时原样透传（未设置 = 走默认）', () => {
    expect(normalizeModelForProfile('', thirdParty)).toBe('')
    expect(normalizeModelForProfile(undefined, thirdParty)).toBeUndefined()
  })

  // ===== 命中 Profile 可选列表：保留 =====

  it('模型在 modelOptions 内时原样保留', () => {
    expect(normalizeModelForProfile('deepseek-v4-flash', thirdParty)).toBe('deepseek-v4-flash')
    expect(normalizeModelForProfile('claude-fable-5-dd-orp-5.2-senga', thirdParty)).toBe(
      'claude-fable-5-dd-orp-5.2-senga',
    )
  })

  it('保留长上下文后缀变体（[1m] 等）', () => {
    expect(normalizeModelForProfile('agnes-2.5-flash[1m]', thirdParty)).toBe('agnes-2.5-flash[1m]')
  })

  it('modelOptions 为空时以 profile.model 为唯一合法值', () => {
    expect(normalizeModelForProfile('deepseek-v4-flash', { model: 'deepseek-v4-flash' })).toBe(
      'deepseek-v4-flash',
    )
    expect(normalizeModelForProfile('opus', { model: 'deepseek-v4-flash' })).toBeUndefined()
  })

  // ===== 未命中：清空，回退 profile.model 默认 =====

  it('【回归】Claude 官方别名发给第三方 Profile 时清空（复现 unknown provider for model opus）', () => {
    expect(normalizeModelForProfile('opus', thirdParty)).toBeUndefined()
    expect(normalizeModelForProfile('sonnet', thirdParty)).toBeUndefined()
    expect(normalizeModelForProfile('haiku', thirdParty)).toBeUndefined()
  })

  it('大小写敏感：拼写偏差视为无效并清空', () => {
    expect(normalizeModelForProfile('DeepSeek-V4-Flash', thirdParty)).toBeUndefined()
  })

  it('历史残留的其他供应商模型名清空（跨 Profile 切换）', () => {
    // 用户从 Profile A 切到 Profile B，config.model 仍是 A 的模型
    const profileB = { model: 'glm-4.7', modelOptions: ['glm-4.7', 'glm-4.6'] }
    expect(normalizeModelForProfile('deepseek-v4-flash', profileB)).toBeUndefined()
  })
})

/**
 * 会话级模型 Profile 的三态解析。
 *
 * 优先级：会话覆盖（SessionMetadata）> 状态栏镜像（sessionConfig）> 全局默认（设置页激活）。
 * 关键修复点：会话级「明确选官方 API」（哨兵）必须优先于全局默认，且哨兵绝不能作为
 * 结果返回（否则会透传后端命中 notFoundRuntime）。
 *
 * 注：此前这里还有 hydrateFromLocalStorage 解析缓存的测试——该链路（localStorage
 * 历史二级恢复）已随死代码清理删除，压缩消息磁盘兜底改走自有 JSONL
 * （dialogStorageService.getCachedFullMessage / loadMessageMap），相关行为由
 * dialogStorage/service.test.ts 覆盖。
 */
describe('resolveEffectiveProfileId', () => {
  // ===== 会话级覆盖：最高优先级 =====

  it('会话指定具体 Profile 时，优先于状态栏镜像与全局默认', () => {
    expect(
      resolveEffectiveProfileId('profile_session', 'profile_mirror', 'profile_global'),
    ).toBe('profile_session')
  })

  it('【回归】会话明确选官方（哨兵）时返回 undefined，优先于全局默认（不再静默回退）', () => {
    // 旧实现用 || 短路：哨兵前是空值 → 一路回退到 profile_global，造成「答非所选 / 意外费用」。
    expect(
      resolveEffectiveProfileId(OFFICIAL_API_PROFILE, 'profile_mirror', 'profile_global'),
    ).toBeUndefined()
  })

  it('会话明确选官方且无全局默认时返回 undefined', () => {
    expect(resolveEffectiveProfileId(OFFICIAL_API_PROFILE, undefined, undefined)).toBeUndefined()
  })

  it('会话级空串等同于明确选官方，返回 undefined', () => {
    expect(
      resolveEffectiveProfileId('', 'profile_mirror', 'profile_global'),
    ).toBeUndefined()
  })

  // ===== 未设置会话覆盖：向下降级 =====

  it('会话未设置时降级到状态栏镜像', () => {
    expect(
      resolveEffectiveProfileId(undefined, 'profile_mirror', 'profile_global'),
    ).toBe('profile_mirror')
  })

  it('会话未设置、镜像为空串时降级到全局默认', () => {
    expect(resolveEffectiveProfileId(undefined, '', 'profile_global')).toBe('profile_global')
  })

  it('会话未设置、镜像为 undefined 时降级到全局默认', () => {
    expect(
      resolveEffectiveProfileId(undefined, undefined, 'profile_global'),
    ).toBe('profile_global')
  })

  it('三档全空时返回 undefined（走官方端点）', () => {
    expect(resolveEffectiveProfileId(undefined, undefined, undefined)).toBeUndefined()
    expect(resolveEffectiveProfileId(undefined, '', undefined)).toBeUndefined()
  })

  // ===== 健壮性：哨兵绝不透传后端 =====

  it('哨兵即便误入镜像 / 全局档也绝不作为结果返回', () => {
    expect(
      resolveEffectiveProfileId(undefined, OFFICIAL_API_PROFILE, undefined),
    ).toBeUndefined()
    expect(
      resolveEffectiveProfileId(undefined, undefined, OFFICIAL_API_PROFILE),
    ).toBeUndefined()
  })
})

/**
 * 供应商选择模式（官方/分组/指定 Profile）三态解析。
 *
 * 优先级通 resolveEffectiveProfileId：会话级覆盖 > 状态栏镜像。返回 undefined
 * 表示跟随全局旧逻辑（发请求时不带 profileMode 字段，后端 None 向前兼容）。
 */
describe('resolveEffectiveProfileMode', () => {
  it('会话级覆盖优先生效', () => {
    expect(resolveEffectiveProfileMode('group', 'profile')).toBe('group')
    expect(resolveEffectiveProfileMode('official', 'group')).toBe('official')
    expect(resolveEffectiveProfileMode('profile', undefined)).toBe('profile')
    // 会话级覆盖优先于 defaultToGroup 兜底
    expect(resolveEffectiveProfileMode('profile', undefined, true)).toBe('profile')
  })

  it('无会话覆盖且镜像非 profile 时跟随状态栏镜像', () => {
    expect(resolveEffectiveProfileMode(undefined, 'group')).toBe('group')
    expect(resolveEffectiveProfileMode(undefined, 'official')).toBe('official')
    // 镜像兜底默认 'profile'
    expect(resolveEffectiveProfileMode(undefined, 'profile')).toBe('profile')
  })

  it('defaultToGroup 兜底：镜像 profile 且无会话覆盖时自动补 group', () => {
    expect(resolveEffectiveProfileMode(undefined, 'profile', true)).toBe('group')
    // 会话覆盖存在时不触发兜底
    expect(resolveEffectiveProfileMode('profile', 'profile', true)).toBe('profile')
    // 镜像已是 group/official 时以镜像为准
    expect(resolveEffectiveProfileMode(undefined, 'group', true)).toBe('group')
    expect(resolveEffectiveProfileMode(undefined, 'official', true)).toBe('official')
  })

  it('未设置时返回 undefined（无分组兜底）', () => {
    expect(resolveEffectiveProfileMode(undefined, undefined)).toBeUndefined()
    // 有 defaultToGroup 时 undefined → group；否则 undefined
    expect(resolveEffectiveProfileMode(undefined, undefined, true)).toBe('group')
  })
})

describe('isProfileModeWithoutProfile', () => {
  it('official/group 不绑定单 Profile', () => {
    expect(isProfileModeWithoutProfile('official')).toBe(true)
    expect(isProfileModeWithoutProfile('group')).toBe(true)
  })

  it('profile 与 undefined 绑定单 Profile（沿用旧逻辑）', () => {
    expect(isProfileModeWithoutProfile('profile')).toBe(false)
    expect(isProfileModeWithoutProfile(undefined)).toBe(false)
  })
})
