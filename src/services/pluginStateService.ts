import { invoke } from './transport'

/** K-R5 批E4：plugin_state_load/save 命令删除，走 cap.pluginState 总线 */
async function pluginStateDispatch<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const res = await invoke<{ msgId: string; ok: boolean; result: T; error: string | null }>('router_dispatch', {
    req: { target: 'cap.pluginState', payload: { action, ...payload } },
  })
  if (!res.ok) throw new Error(res.error || ('cap.pluginState ' + action + ' 失败'))
  return res.result
};
import type { PluginStateMap } from '@/stores/pluginStore';

export function loadPluginStates(): Promise<PluginStateMap> {
  return pluginStateDispatch<PluginStateMap>('get_states');
}

export function savePluginStates(states: PluginStateMap): Promise<void> {
  return pluginStateDispatch('set_states', { states });
}
