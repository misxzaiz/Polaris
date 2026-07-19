/**
 * app.js — 应用入口
 *
 * 职责: 实例化引擎、配置、UI，启动应用
 * 生命周期: 创建引擎 → 配置 → 注册系统 → 启动
 *
 * 版本: v1.0 · 2026-07-19
 */

import { WorldEngine } from './core/engine.js';
import { WorldConfig } from './data/world-config.js';
import { SceneManager } from './core/scene.js';
import { CameraSystem } from './core/camera.js';
import { ClockSystem } from './core/clock.js';
import { TerrainGenerator } from './world/terrain.js';
import { CityGenerator } from './world/city.js';
import { FloraGenerator } from './world/flora.js';
import { WaterGenerator } from './world/water.js';
import { FXSystem } from './world/fx.js';
import { LightSystem } from './systems/light.js';
import { SkySystem } from './systems/sky.js';
import { FogSystem } from './systems/fog.js';
import { ShadowManager } from './systems/shadow.js';
import { PanelController } from './ui/panel.js';
import { HUDController } from './ui/hud.js';

export class App {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {typeof WorldConfig} [ConfigClass]
   */
  constructor(canvas, ConfigClass = WorldConfig) {
    this.canvas = canvas;
    this.config = new ConfigClass();
    this.engine = null;
    this.systems = {};
  }

  /** 初始化并启动 */
  init() {
    this.engine = new WorldEngine(this.canvas, this.config);
    this.engine.init();
    this.engine.mount();

    // 注册系统
    this.systems.light = new LightSystem(this.config);
    this.engine.registerSystem(this.systems.light);

    this.systems.sky = new SkySystem(this.config);
    this.engine.registerSystem(this.systems.sky);

    this.systems.fog = new FogSystem(this.config);
    this.systems.fog.init(this.engine.scene);

    this.systems.hud = new HUDController();
    this.engine.registerSystem(this.systems.hud);

    this.systems.panel = new PanelController(this.config);
    this.systems.panel.init();

    this.engine.start();
    return this;
  }
}
