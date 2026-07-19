/**
 * ShadowManager — 阴影管理
 *
 * 职责: 阴影相机范围、分辨率、性能降级
 * 性能预算: shadowMapSize 可在性能告警时降级
 *
 * 版本: v1.0 · 2026-07-19
 */

export class ShadowManager {
  /** @param {import('../data/world-config.js').WorldConfig} config */
  constructor(config) {
    this.config = config;
    this.directionalLight = null;
  }

  /** @param {import('three').DirectionalLight} light */
  init(light) {
    this.directionalLight = light;
    if (!light) return;
    light.shadow.mapSize.width = 2048;
    light.shadow.mapSize.height = 2048;
    light.shadow.camera.near = 1;
    light.shadow.camera.far = 600;
    light.shadow.camera.left = -500;
    light.shadow.camera.right = 500;
    light.shadow.camera.top = 500;
    light.shadow.camera.bottom = -500;
    light.shadow.bias = -0.0004;
    return this;
  }

  /** 降级阴影 */
  downgrade() {
    // 到 1024x1024
  }
}
