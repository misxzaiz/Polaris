/**
 * FogSystem — 雾系统
 *
 * 配置驱动: config.atmosphere.fogDensity / fogColor
 * 时刻联动: 夜晚雾色变深、白天变淡
 *
 * 版本: v1.0 · 2026-07-19
 */

export class FogSystem {
  /** @param {import('../data/world-config.js').WorldConfig} config */
  constructor(config) {
    this.config = config;
    this.scene = null;
  }

  /** @param {import('three').Scene} scene */
  init(scene) {
    this.scene = scene;
    this.applyFog(this.config.get('atmosphere.fogDensity') || 0.018);
    return this;
  }

  /** @param {number} density */
  applyFog(density) {
    if (!this.scene) return;
    // 待实现: scene.fog 或 scene.fogExp2
  }

  /** @param {number} hour */
  applyTime(hour) {
    // 时刻驱动雾色
  }
}
