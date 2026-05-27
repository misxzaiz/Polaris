/**
 * 集成平台相关 Tauri 命令
 * 包含：钉钉、集成平台（QQ/飞书等）、实例管理
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
} from '@/types';
import type { PlatformInstance, InstanceId } from '@/types';

// ============================================================================
// 钉钉相关命令
// ============================================================================

/** 启动钉钉服务 */
export async function startDingTalkService(): Promise<void> {
  return invoke('start_dingtalk_service');
}

/** 停止钉钉服务 */
export async function stopDingTalkService(): Promise<void> {
  return invoke('stop_dingtalk_service');
}

/** 发送钉钉消息 */
export async function sendDingTalkMessage(content: string, conversationId: string): Promise<void> {
  return invoke('send_dingtalk_message', { content, conversationId });
}

/** 检查钉钉服务是否运行 */
export async function isDingTalkServiceRunning(): Promise<boolean> {
  return invoke('is_dingtalk_service_running');
}

/** 获取钉钉服务状态 */
export async function getDingTalkServiceStatus(): Promise<{
  isRunning: boolean;
  pid?: number;
  port?: number;
  error?: string;
}> {
  return invoke('get_dingtalk_service_status');
}

/** 测试钉钉连接 */
export async function testDingTalkConnection(testMessage: string, conversationId: string): Promise<string> {
  return invoke('test_dingtalk_connection', { testMessage, conversationId });
}

// ============================================================================
// 集成平台命令
// ============================================================================

/** 启动集成平台 */
export async function startIntegration(platform: Platform): Promise<void> {
  return invoke('start_integration', { platform });
}

/** 停止集成平台 */
export async function stopIntegration(platform: Platform): Promise<void> {
  return invoke('stop_integration', { platform });
}

/** 获取集成状态 */
export async function getIntegrationStatus(platform: Platform): Promise<IntegrationStatus | null> {
  return invoke<IntegrationStatus | null>('get_integration_status', { platform });
}

/** 获取所有集成状态 */
export async function getAllIntegrationStatus(): Promise<Record<string, IntegrationStatus>> {
  return invoke<Record<string, IntegrationStatus>>('get_all_integration_status');
}

/** 发送集成消息 */
export async function sendIntegrationMessage(
  platform: Platform,
  target: SendTarget,
  content: MessageContent
): Promise<void> {
  return invoke('send_integration_message', { platform, target, content });
}

/** 获取集成会话列表 */
export async function getIntegrationSessions(): Promise<IntegrationSession[]> {
  return invoke<IntegrationSession[]>('get_integration_sessions');
}

/** 初始化集成管理器 */
export async function initIntegration(qqbotConfig: QQBotConfig | null, feishuConfig: FeishuConfig | null): Promise<void> {
  return invoke('init_integration', { qqbotConfig, feishuConfig });
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
  return invoke<InstanceId>('add_integration_instance', { instance });
}

/** 移除集成实例 */
export async function removeIntegrationInstance(
  instanceId: InstanceId
): Promise<PlatformInstance | null> {
  return invoke<PlatformInstance | null>('remove_integration_instance', { instanceId });
}

/** 获取所有集成实例 */
export async function listIntegrationInstances(): Promise<PlatformInstance[]> {
  return invoke<PlatformInstance[]>('list_integration_instances');
}

/** 按平台获取实例列表 */
export async function listIntegrationInstancesByPlatform(
  platform: Platform
): Promise<PlatformInstance[]> {
  return invoke<PlatformInstance[]>('list_integration_instances_by_platform', { platform });
}

/** 获取当前激活的实例 */
export async function getActiveIntegrationInstance(
  platform: Platform
): Promise<PlatformInstance | null> {
  return invoke<PlatformInstance | null>('get_active_integration_instance', { platform });
}

/** 切换实例 */
export async function switchIntegrationInstance(
  instanceId: InstanceId
): Promise<void> {
  return invoke('switch_integration_instance', { instanceId });
}

/** 断开当前实例 */
export async function disconnectIntegrationInstance(
  platform: Platform
): Promise<void> {
  return invoke('disconnect_integration_instance', { platform });
}

/** 更新实例配置 */
export async function updateIntegrationInstance(
  instance: PlatformInstance
): Promise<void> {
  return invoke('update_integration_instance', { instance });
}
