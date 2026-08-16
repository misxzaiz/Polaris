import { describe, it, expect } from 'vitest'
import {
  resolveEffectiveProfileId,
  resolveEffectiveProfileMode,
  isProfileModeWithoutProfile,
} from './conversationStoreUtils'
import { OFFICIAL_API_PROFILE } from '@/types/modelProfile'

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
