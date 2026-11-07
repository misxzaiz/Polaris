/**
 * cap 桥宿主注册模块（动态加载）
 *
 * 被 plugin-system/hostBridge.ensureCapHostRegistered() 动态 import，把
 * forwardCardCapRequest（协议校验 + deny 清单 + 声明白名单 + router_dispatch）
 * 挂到 window.__POLARIS_HOST_CAP__——自由组件的 cap 调用经 polaris-host/cap
 * shim 消费（plugin-ui-contribution-spec [S-8] 三重门控的宿主执行点）。
 */

import { forwardCardCapRequest, type CardCapRequest } from '@/utils/htmlCardCapBridge'
import { invoke } from './transport'

export interface CapHostBridge {
  /**
   * 转发一次组件 cap 请求（data 为 iframe postMessage 的原始负载）。
   * declaredTargets：AI 经 marker.caps 声明的白名单（无声明时不做声明校验，
   * 仅 deny 清单 + 静态 allowlist 生效——与 v1 语义一致）。
   * 返回 CardCapResponse（由调用方 postMessage 弹回 iframe）。
   */
  forwardCap: (data: CardCapRequest, declaredTargets?: readonly string[]) => Promise<unknown>
}

export function registerCapHost(): void {
  const bridge: CapHostBridge = {
    forwardCap: (data, declaredTargets) =>
      forwardCardCapRequest(data, invoke, {
        declaredTargets: declaredTargets ? new Set(declaredTargets) : undefined,
      }),
  }
  ;(window as unknown as Record<string, unknown>).__POLARIS_HOST_CAP__ = bridge
}

declare global {
  // eslint-disable-next-line no-var
  var __POLARIS_HOST_CAP__: CapHostBridge | undefined
}
