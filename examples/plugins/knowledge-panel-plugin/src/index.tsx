/**
 * Knowledge Panel — plugin entry.
 *
 * This file is what `host loadPluginPanel(...)` consumes. Default export is
 * the top-level React component the host renders inside its layout. Props
 * include `api: PolarisPluginApi`, the host-minted runtime surface.
 *
 * Responsibilities:
 *   1. Stash the API into the module-level `runtime.ts` so other files can
 *      `import { invoke, createLogger, ... } from '../runtime'` without
 *      threading props everywhere.
 *   2. Register the plugin's i18n resource bundles on first mount so
 *      `useTranslation('knowledge')` works.
 *   3. Render the real `KnowledgePanel` component.
 *
 * Idempotency: the host caches the loaded module via React.lazy, so this
 * module evaluates exactly once per session. Multiple `<KnowledgePanelEntry>`
 * mounts share the same `runtime.ts` singleton and only register i18n
 * resources once.
 */

import { setHostApi } from './runtime'
import type { PolarisPluginApi } from './host-api.types'
import { KnowledgePanel } from './components/KnowledgePanel'
import zhCN from './locales/zh-CN/knowledge.json'
import enUS from './locales/en-US/knowledge.json'

const I18N_NAMESPACE = 'knowledge'
let i18nRegistered = false

function ensureI18nResources(api: PolarisPluginApi): void {
  if (i18nRegistered) return
  api.i18n.addResourceBundle('zh-CN', I18N_NAMESPACE, zhCN, /* deep */ true, /* overwrite */ true)
  api.i18n.addResourceBundle('en-US', I18N_NAMESPACE, enUS, true, true)
  i18nRegistered = true
}

export interface KnowledgePanelEntryProps {
  api: PolarisPluginApi
}

export default function KnowledgePanelEntry({ api }: KnowledgePanelEntryProps) {
  // Set the host API exactly once — subsequent mounts are no-ops because the
  // host hands us the same instance and `setHostApi` is idempotent on identity.
  setHostApi(api)
  ensureI18nResources(api)

  return <KnowledgePanel />
}
