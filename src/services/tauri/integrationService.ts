/**
 * 集成平台相关服务
 * 包含：集成平台（QQ/飞书/钉钉）、实例管理
 *
 * L0 cap 化（plans/im-integration-extraction-spec.md）：全部调用经
 * router_dispatch → cap.integration（统一权限 gate + 审计）；旧 integration_*
 * Tauri 命令保留双轨（插件化 L2 阶段一并删除）。
 */

import { invoke } from '@/services/transport';
import type {
  Platform,
  IntegrationStatus,
  IntegrationMessage,
  IntegrationSession,
  SendTarget,
  MessageContent,
  QQBotConfig,
  FeishuConfig,
  DingTalkConfig,
} from '@/types';
import type { PlatformInstance, InstanceId } from '@/types';

/** router_dispatch 返回形态（与 commands/router.rs RouterDispatchResponse 对应） */
interface DispatchResponse {
  msgId: string
  ok: boolean
  result: Record<string, unknown> | null
  error: string | null
  trace: string
}

/** 经 RouterBus dispatch 调用 cap.integration */
async function dispatchIntegration<T = Record<string, unknown>>(
  action: string,
  extra?: Record<string, unknown>,
): Promise<T> {
  const res = await invoke<DispatchResponse>('router_dispatch', {
    req: {
      target: 'cap.integration',
      payload: { action, ...(extra ?? {}) },
    },
  })
  if (!res.ok) {
    throw new Error(res.error || `cap.integration ${action} 失败`)
  }
  return (res.result ?? {}) as T
}

// ============================================================================
// 集成平台命令
// ============================================================================

/** 启动集成平台 */
export async function startIntegration(platform: Platform): Promise<void> {
  await dispatchIntegration('start', { platform });
}

/** 停止集成平台 */
export async function stopIntegration(platform: Platform): Promise<void> {
  await dispatchIntegration('stop', { platform });
}

/** 获取集成状态 */
export async function getIntegrationStatus(platform: Platform): Promise<IntegrationStatus | null> {
  const r = await dispatchIntegration<{ status: IntegrationStatus | null }>('status', { platform });
  return r.status ?? null;
}

/** 获取所有集成状态 */
export async function getAllIntegrationStatus(): Promise<Record<string, IntegrationStatus>> {
  const r = await dispatchIntegration<{ statuses: Record<string, IntegrationStatus> }>('status_all');
  return r.statuses ?? {};
}

/** 发送集成消息 */
export async function sendIntegrationMessage(
  platform: Platform,
  target: SendTarget,
  content: MessageContent
): Promise<void> {
  await dispatchIntegration('send', { platform, target, content });
}

/** 获取集成会话列表 */
export async function getIntegrationSessions(): Promise<IntegrationSession[]> {
  const r = await dispatchIntegration<{ sessions: IntegrationSession[] }>('sessions');
  return r.sessions ?? [];
}

/** 初始化集成管理器 */
export async function initIntegration(qqbotConfig: QQBotConfig | null, feishuConfig: FeishuConfig | null, dingtalkConfig?: DingTalkConfig | null): Promise<void> {
  await dispatchIntegration('init', { qqbotConfig, feishuConfig, dingtalkConfig: dingtalkConfig ?? null });
}

/** 监听集成消息事件 */
export async function onIntegrationMessage(
  callback: (message: IntegrationMessage) => void
): Promise<() => void> {
  const { listen: listenFn } = await import('@/services/transport');
  return listenFn<IntegrationMessage>('integration:message', (payload) => {
    callback(payload);
  });
}

// ============================================================================
// 实例管理
// ============================================================================

/** 添加集成实例 */
export async function addIntegrationInstance(
  instance: PlatformInstance
): Promise<InstanceId> {
  const r = await dispatchIntegration<{ instanceId: InstanceId }>('add_instance', { instance });
  return r.instanceId;
}

/** 移除集成实例 */
export async function removeIntegrationInstance(
  instanceId: InstanceId
): Promise<PlatformInstance | null> {
  const r = await dispatchIntegration<{ instance: PlatformInstance | null }>('remove_instance', { instanceId });
  return r.instance ?? null;
}

/** 获取所有集成实例 */
export async function listIntegrationInstances(): Promise<PlatformInstance[]> {
  const r = await dispatchIntegration<{ instances: PlatformInstance[] }>('list_instances');
  return r.instances ?? [];
}

/** 按平台获取实例列表 */
export async function listIntegrationInstancesByPlatform(
  platform: Platform
): Promise<PlatformInstance[]> {
  const r = await dispatchIntegration<{ instances: PlatformInstance[] }>('list_instances_by_platform', { platform });
  return r.instances ?? [];
}

/** 获取当前激活的实例 */
export async function getActiveIntegrationInstance(
  platform: Platform
): Promise<PlatformInstance | null> {
  const r = await dispatchIntegration<{ instance: PlatformInstance | null }>('get_active_instance', { platform });
  return r.instance ?? null;
}

/** 切换实例 */
export async function switchIntegrationInstance(
  instanceId: InstanceId
): Promise<void> {
  await dispatchIntegration('switch_instance', { instanceId });
}

/** 断开当前实例 */
export async function disconnectIntegrationInstance(
  platform: Platform
): Promise<void> {
  await dispatchIntegration('disconnect_instance', { platform });
}

/** 更新实例配置 */
export async function updateIntegrationInstance(
  instance: PlatformInstance
): Promise<void> {
  await dispatchIntegration('update_instance', { instance });
}
