/**
 * PanelController — 控制面板组件
 *
 * 职责: 绑定 UI 控件到 WorldConfig，双向同步
 * 策略: 滑块 input 事件即时更新，change 事件触发重建
 *
 * 版本: v1.0 · 2026-07-19
 */

export class PanelController {
  /** @param {import('../data/world-config.js').WorldConfig} config */
  constructor(config) {
    this.config = config;
    this._listeners = new Map();
  }

  /** 初始化面板绑定 */
  init() {
    return this;
  }
}
