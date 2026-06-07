import { describe, it, expect } from 'vitest'
import { resolveEffectiveProfileId } from './conversationStoreUtils'
import { OFFICIAL_API_PROFILE } from '@/types/modelProfile'

/**
 * 会话级模型 Profile 的三态解析。
 *
 * 优先级：会话覆盖（SessionMetadata）> 状态栏镜像（sessionConfig）> 全局默认（设置页激活）。
 * 关键修复点：会话级「明确选官方 API」（哨兵）必须优先于全局默认，且哨兵绝不能作为
 * 结果返回（否则会透传后端命中 notFoundRuntime）。
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
