import { describe, expect, it } from 'vitest'
import {
  HOST_API_VERSION,
  PluginApiVersionMismatchError,
  RangeSyntaxError,
  assertHostSatisfies,
  compareVersions,
  parseVersion,
  satisfies,
} from './version'

describe('parseVersion', () => {
  it('parses release versions', () => {
    const v = parseVersion('1.2.3')
    expect(v).toMatchObject({ major: 1, minor: 2, patch: 3, prerelease: null })
  })

  it('parses prerelease versions', () => {
    const v = parseVersion('0.1.0-alpha.2')
    expect(v).toMatchObject({ major: 0, minor: 1, patch: 0, prerelease: 'alpha.2' })
  })

  it('rejects non-semver strings', () => {
    expect(() => parseVersion('1.0')).toThrow(RangeSyntaxError)
    expect(() => parseVersion('1.0.0.0')).toThrow(RangeSyntaxError)
    expect(() => parseVersion('v1.0.0')).toThrow(RangeSyntaxError)
  })
})

describe('compareVersions', () => {
  it('orders release versions', () => {
    expect(compareVersions(parseVersion('1.0.0'), parseVersion('2.0.0'))).toBe(-1)
    expect(compareVersions(parseVersion('1.2.0'), parseVersion('1.1.9'))).toBe(1)
    expect(compareVersions(parseVersion('1.2.3'), parseVersion('1.2.3'))).toBe(0)
  })

  it('treats prerelease as lower than the same release', () => {
    expect(
      compareVersions(parseVersion('1.0.0-alpha.1'), parseVersion('1.0.0'))
    ).toBe(-1)
  })

  it('orders prereleases numerically then lex', () => {
    expect(
      compareVersions(parseVersion('1.0.0-alpha.2'), parseVersion('1.0.0-alpha.10'))
    ).toBe(-1)
    expect(
      compareVersions(parseVersion('1.0.0-alpha'), parseVersion('1.0.0-beta'))
    ).toBe(-1)
  })

  it('shorter prerelease identifier list is lower when prefix matches', () => {
    expect(
      compareVersions(parseVersion('1.0.0-alpha'), parseVersion('1.0.0-alpha.1'))
    ).toBe(-1)
  })
})

describe('satisfies — caret ranges', () => {
  it('1.x release: ^1.2.3 admits >=1.2.3 <2.0.0', () => {
    expect(satisfies('1.2.3', '^1.2.3')).toBe(true)
    expect(satisfies('1.9.0', '^1.2.3')).toBe(true)
    expect(satisfies('2.0.0', '^1.2.3')).toBe(false)
    expect(satisfies('1.2.2', '^1.2.3')).toBe(false)
  })

  it('0.x release: ^0.2.3 admits >=0.2.3 <0.3.0', () => {
    expect(satisfies('0.2.3', '^0.2.3')).toBe(true)
    expect(satisfies('0.2.9', '^0.2.3')).toBe(true)
    expect(satisfies('0.3.0', '^0.2.3')).toBe(false)
  })

  it('0.0.x release: ^0.0.3 admits exactly 0.0.3', () => {
    expect(satisfies('0.0.3', '^0.0.3')).toBe(true)
    expect(satisfies('0.0.4', '^0.0.3')).toBe(false)
  })
})

describe('satisfies — tilde ranges', () => {
  it('~1.2.3 admits >=1.2.3 <1.3.0', () => {
    expect(satisfies('1.2.3', '~1.2.3')).toBe(true)
    expect(satisfies('1.2.9', '~1.2.3')).toBe(true)
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false)
  })
})

describe('satisfies — exact and wildcard', () => {
  it('exact match', () => {
    expect(satisfies('1.2.3', '1.2.3')).toBe(true)
    expect(satisfies('1.2.4', '1.2.3')).toBe(false)
  })

  it('wildcards admit everything', () => {
    expect(satisfies('1.2.3', '*')).toBe(true)
    expect(satisfies('0.0.1', 'x')).toBe(true)
    expect(satisfies('99.99.99', 'X')).toBe(true)
  })
})

describe('satisfies — error cases', () => {
  it('rejects empty and unsupported syntax', () => {
    expect(() => satisfies('1.0.0', '')).toThrow(RangeSyntaxError)
    expect(() => satisfies('1.0.0', '>1.0.0')).toThrow(RangeSyntaxError)
    expect(() => satisfies('1.0.0', '>=1.0.0 <2.0.0')).toThrow(RangeSyntaxError)
    expect(() => satisfies('1.0.0', '1.0.0 || 2.0.0')).toThrow(RangeSyntaxError)
  })
})

describe('assertHostSatisfies', () => {
  it('passes when host matches', () => {
    // Match the current HOST_API_VERSION via wildcard to stay future-proof.
    expect(() => assertHostSatisfies('demo', '*')).not.toThrow()
  })

  it('throws PluginApiVersionMismatchError when host does not match', () => {
    expect(() => assertHostSatisfies('demo', '99.0.0')).toThrow(
      PluginApiVersionMismatchError
    )
  })

  it('error carries plugin id, required range, and host version', () => {
    try {
      assertHostSatisfies('com.example.foo', '99.0.0')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(PluginApiVersionMismatchError)
      const typed = err as PluginApiVersionMismatchError
      expect(typed.pluginId).toBe('com.example.foo')
      expect(typed.required).toBe('99.0.0')
      expect(typed.hostVersion).toBe(HOST_API_VERSION)
    }
  })
})
