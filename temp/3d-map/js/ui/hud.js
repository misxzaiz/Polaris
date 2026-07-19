/**
 * HUDController — 性能 HUD（FPS / 三角面 / draw call）
 *
 * 数据源: renderer.info.render
 * 刷新率: 每 0.5s 更新一次
 *
 * 版本: v1.0 · 2026-07-19
 */

export class HUDController {
  constructor() {
    this._frameCount = 0;
    this._lastSample = 0;
    this._fps = 0;
  }

  /** @param {import('three').WebGLRenderer} renderer * @param {number} time */
  update(renderer, time) {
    this._frameCount++;
    if (time - this._lastSample >= 500) {
      this._fps = Math.round(this._frameCount * 1000 / (time - this._lastSample));
      this._frameCount = 0;
      this._lastSample = time;
      if (renderer && renderer.info) {
        const info = renderer.info.render;
        // 更新 DOM
      }
    }
  }
}
