/**
 * Plugin API version negotiation.
 *
 * The host advertises `HOST_API_VERSION`; plugins declare a `requires.apiVersion`
 * range in their manifest. On load, the host calls `satisfies(hostVer, range)`
 * and refuses plugins that don't match.
 *
 * ## Supported range syntax (deliberately limited for v1)
 *
 * - `1.2.3`      — exact match
 * - `^1.2.3`     — caret: `>=1.2.3 <2.0.0` (or `>=0.x.y <0.(x+1).0` for 0.x)
 * - `~1.2.3`     — tilde: `>=1.2.3 <1.3.0`
 * - `*`          — any version
 *
 * Pre-release tags (`-alpha.1`) participate in equality and the lower bound
 * but always satisfy the upper bound (i.e. `^1.0.0-alpha.1` admits `1.0.0`).
 *
 * Anything else (`||`, `>`, ranges with spaces) throws `RangeSyntaxError`.
 * If a plugin needs more, ship a richer semver lib then; we don't ship one
 * pre-emptively to keep the bundle thin.
 */

/**
 * The current host-side API version.
 *
 * **Bump rules** (strict semver):
 * - PATCH: bug fixes that preserve plugin contracts
 * - MINOR: additive (new fields on `PolarisPluginApi`, new IPC commands available)
 * - MAJOR: breaking (renamed/removed fields, changed signatures)
 *
 * Until `1.0.0`, treat MINOR bumps as potentially breaking and pin plugins
 * to exact versions or `~` ranges.
 */
export const HOST_API_VERSION = '0.1.0' as const

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RangeSyntaxError extends Error {
  constructor(public readonly range: string, reason: string) {
    super(`Invalid plugin API version range "${range}": ${reason}`)
    this.name = 'RangeSyntaxError'
  }
}

// ---------------------------------------------------------------------------
// Internal parsing
// ---------------------------------------------------------------------------

interface Version {
  major: number
  minor: number
  patch: number
  prerelease: string | null
  raw: string
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

export function parseVersion(input: string): Version {
  const m = VERSION_RE.exec(input.trim())
  if (!m) {
    throw new RangeSyntaxError(input, 'not a major.minor.patch[-prerelease] version')
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
    raw: input.trim(),
  }
}

/**
 * Compare two versions. Returns -1 / 0 / 1.
 *
 * Pre-release ordering follows semver 11: numeric identifiers compared as
 * numbers, alphabetic compared lex, fewer identifiers come first when all
 * compared identifiers are equal. A version *with* a prerelease is lower
 * than the same version *without*.
 */
export function compareVersions(a: Version, b: Version): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === null) return 1
  if (b.prerelease === null) return -1
  const ap = a.prerelease.split('.')
  const bp = b.prerelease.split('.')
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (i >= ap.length) return -1
    if (i >= bp.length) return 1
    const ai = ap[i]
    const bi = bp[i]
    const an = /^\d+$/.test(ai) ? Number(ai) : null
    const bn = /^\d+$/.test(bi) ? Number(bi) : null
    if (an !== null && bn !== null) {
      if (an !== bn) return an < bn ? -1 : 1
    } else if (an !== null) {
      return -1 // numeric identifiers always have lower precedence
    } else if (bn !== null) {
      return 1
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1
    }
  }
  return 0
}

// ---------------------------------------------------------------------------
// Range matching
// ---------------------------------------------------------------------------

interface Bounds {
  lower: { v: Version; inclusive: true }
  upper: { v: Version; inclusive: false } | null
}

function caretUpperBound(v: Version): Version {
  // ^1.2.3 → <2.0.0
  // ^0.2.3 → <0.3.0
  // ^0.0.3 → <0.0.4
  if (v.major > 0) {
    return parseVersion(`${v.major + 1}.0.0`)
  }
  if (v.minor > 0) {
    return parseVersion(`0.${v.minor + 1}.0`)
  }
  return parseVersion(`0.0.${v.patch + 1}`)
}

function tildeUpperBound(v: Version): Version {
  return parseVersion(`${v.major}.${v.minor + 1}.0`)
}

function parseRange(range: string): Bounds | 'any' {
  const trimmed = range.trim()
  if (!trimmed) throw new RangeSyntaxError(range, 'empty range')
  if (trimmed === '*' || trimmed === 'x' || trimmed === 'X') return 'any'

  const head = trimmed[0]
  if (head === '^') {
    const v = parseVersion(trimmed.slice(1))
    return { lower: { v, inclusive: true }, upper: { v: caretUpperBound(v), inclusive: false } }
  }
  if (head === '~') {
    const v = parseVersion(trimmed.slice(1))
    return { lower: { v, inclusive: true }, upper: { v: tildeUpperBound(v), inclusive: false } }
  }
  if (head === '>' || head === '<' || head === '=' || head === ' ') {
    // Reject the comparator/space syntax explicitly — we documented this.
    throw new RangeSyntaxError(range, 'comparators (>, <, =, spaces) not supported in v1')
  }

  // Bare exact version.
  const v = parseVersion(trimmed)
  return { lower: { v, inclusive: true }, upper: { v, inclusive: false } } // exact: [v, v) is empty, handle below
}

/**
 * Does `version` satisfy `range`?
 *
 * @param version A concrete semver (e.g. `HOST_API_VERSION`)
 * @param range   A range string (`^1.2.3`, `~1.2.3`, `*`, exact)
 * @throws RangeSyntaxError if `range` cannot be parsed
 */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version)
  const bounds = parseRange(range)
  if (bounds === 'any') return true

  // Exact-version range: bounds.lower === bounds.upper, treat as ==.
  if (bounds.upper && bounds.lower.v.raw === bounds.upper.v.raw) {
    return compareVersions(v, bounds.lower.v) === 0
  }

  const lowerCmp = compareVersions(v, bounds.lower.v)
  if (lowerCmp < 0) return false
  if (lowerCmp === 0 && !bounds.lower.inclusive) return false

  if (bounds.upper) {
    const upperCmp = compareVersions(v, bounds.upper.v)
    if (upperCmp > 0) return false
    if (upperCmp === 0 && !bounds.upper.inclusive) return false
  }

  return true
}

/**
 * Convenience: throw a typed error when a plugin's required range is not
 * satisfied by the current host.
 */
export class PluginApiVersionMismatchError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly required: string,
    public readonly hostVersion: string
  ) {
    super(
      `Plugin "${pluginId}" requires Polaris plugin API "${required}" ` +
        `but host provides "${hostVersion}".`
    )
    this.name = 'PluginApiVersionMismatchError'
  }
}

export function assertHostSatisfies(pluginId: string, required: string): void {
  if (!satisfies(HOST_API_VERSION, required)) {
    throw new PluginApiVersionMismatchError(pluginId, required, HOST_API_VERSION)
  }
}
