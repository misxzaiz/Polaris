/**
 * ClockSystem — 时间系统
 *
 * 职责: 帧时间 delta、时刻插值、事件通知
 * 响应式: 通过 config.time.hour 驱动天空/光照/雾联动
 *
 * 版本: v1.0 · 2026-07-19
 */

export class ClockSystem {
  /** @param {import('../data/world-config.js').WorldConfig} config */
  constructor(config) {
    this.config = config;
    this._lastTime = 0;
    this._elapsed = 0;
    this._callbacks = [];
  }

  /**
   * 每帧调用，返回 delta time (秒)
   * @param {number} time - requestAnimationFrame 时间戳
   * @returns {number} 秒
   */
  tick(time) {
    if (this._lastTime === 0) {
      this._lastTime = time;
      return 0;
    }
    const dt = Math.min((time - this._lastTime) / 1000, 0.1); // 上限 100ms
    this._lastTime = time;
    this._elapsed += dt;
    this._notify('tick', dt);
    return dt;
  }

  /** @param {number} hour */
  set hour(v) {
    this.config.set('time.hour', Math.max(0, Math.min(24, v)));
    this._notify('hour', this.config.get('time.hour'));
  }

  get hour() { return this.config.get('time.hour'); }

  /** @param {(hour: number) => void} cb */
  onTimeChange(cb) {
    this._callbacks.push(cb);
  }

  get elapsed() { return this._elapsed; }

  _notify(type, value) {
    for (const cb of this._callbacks) {
      try { cb(value, type); } catch (e) { console.warn('[ClockSystem] callback error:', e); }
    }
  }
}
