import { invoke } from './transport';
import type { PluginStateMap } from '@/stores/pluginStore';

export function loadPluginStates(): Promise<PluginStateMap> {
  return invoke<PluginStateMap>('plugin_state_load');
}

export function savePluginStates(states: PluginStateMap): Promise<void> {
  return invoke<void>('plugin_state_save', { states });
}
