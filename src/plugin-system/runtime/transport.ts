/**
 * Per-plugin transport: mediates IPC `invoke` / `listen` calls against the
 * calling plugin's manifest `permissions.ipc` allowlist.
 *
 * ## Allowlist syntax
 *
 * Entries are matched against the command/event name as either:
 * - **exact match**: `"knowledge_list_modules"` matches only that command
 * - **prefix glob**: `"knowledge_*"` matches anything starting with `knowledge_`
 *
 * No other glob metacharacters are supported in v1. Whitespace around entries
 * is trimmed. Empty entries are ignored.
 *
 * An *absent* allowlist (`undefined`) is treated as **deny-all** — the plugin
 * must declare at least one entry to call anything. This is the safe default.
 */

import { invoke as hostInvoke, listen as hostListen } from '@/services/transport'
import type { PluginTransport } from './api'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PluginPermissionDeniedError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly kind: 'invoke' | 'listen',
    public readonly target: string
  ) {
    super(
      `Plugin "${pluginId}" is not permitted to ${kind} "${target}". ` +
        `Add it to manifest permissions.ipc to allow.`
    )
    this.name = 'PluginPermissionDeniedError'
  }
}

// ---------------------------------------------------------------------------
// Allowlist matching
// ---------------------------------------------------------------------------

/**
 * Compile a list of allowlist patterns into a fast matcher.
 *
 * Returns a closure `(target: string) => boolean`. Patterns are split into
 * an exact-match `Set` and a sorted list of prefix patterns (`foo_*` → `foo_`).
 */
export function compileAllowlist(
  patterns: readonly string[] | undefined
): (target: string) => boolean {
  if (!patterns || patterns.length === 0) {
    return () => false
  }

  const exact = new Set<string>()
  const prefixes: string[] = []

  for (const raw of patterns) {
    const p = raw.trim()
    if (!p) continue
    if (p.endsWith('*')) {
      prefixes.push(p.slice(0, -1))
    } else if (p.includes('*')) {
      // Reject mid-string globs explicitly — keep matcher predictable.
      throw new Error(
        `Invalid permission pattern "${raw}": only suffix glob "prefix*" is supported`
      )
    } else {
      exact.add(p)
    }
  }

  // Sort prefixes by length descending so the most specific wins first
  // (purely a micro-optimization for short-circuit; semantics are identical
  // either way since we only return boolean).
  prefixes.sort((a, b) => b.length - a.length)

  return (target: string) => {
    if (exact.has(target)) return true
    for (const prefix of prefixes) {
      if (target.startsWith(prefix)) return true
    }
    return false
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface PluginTransportOptions {
  pluginId: string
  /**
   * Allowlist for `transport.invoke(cmd, ...)`. See module docstring for
   * pattern syntax. Undefined ⇒ deny-all.
   */
  ipcAllowlist?: readonly string[]
  /**
   * Allowlist for `transport.listen(event, ...)`. Independent of invoke
   * allowlist on purpose: event subscriptions are typically read-only but
   * carry their own data-leak risk.
   *
   * Defaults to the same value as `ipcAllowlist` if omitted.
   */
  eventAllowlist?: readonly string[]
}

/**
 * Build a per-plugin `PluginTransport`. The returned object closes over the
 * compiled allowlist and the plugin id, so a plugin cannot fabricate calls
 * for another plugin even if it gets a handle on this factory.
 */
export function createPluginTransport(
  options: PluginTransportOptions
): PluginTransport {
  const { pluginId, ipcAllowlist, eventAllowlist } = options
  const canInvoke = compileAllowlist(ipcAllowlist)
  const canListen = compileAllowlist(eventAllowlist ?? ipcAllowlist)

  return {
    async invoke<T = unknown>(
      command: string,
      args?: Record<string, unknown>
    ): Promise<T> {
      if (!canInvoke(command)) {
        throw new PluginPermissionDeniedError(pluginId, 'invoke', command)
      }
      return hostInvoke<T>(command, args)
    },

    async listen<T = unknown>(
      event: string,
      handler: (payload: T) => void
    ): Promise<() => void> {
      if (!canListen(event)) {
        throw new PluginPermissionDeniedError(pluginId, 'listen', event)
      }
      // The host's transport already yields the raw payload (see
      // `services/transport/types.ts`), so we pass `handler` through.
      return hostListen<T>(event, handler)
    },
  }
}
