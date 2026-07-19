#!/usr/bin/env node
/**
 * scaffold.js — 3D World 工程骨架自动化生成器
 *
 * 职责:
 *   按 architecture-spec.md 与 tasklist.md 的规格定义，自动生成缺失的 JS 模块脚手架。
 *   每个生成的文件包含: 正确 import/export、JSDoc 注释、基本信息桩。
 *
 * 生成策略:
 *   1. 已有文件 → 跳过 (不覆盖)
 *   2. 缺失文件 → 按模板生成，内容遵循架构规格中的接口定义
 *   3. 骨架内容可编译、可运行 (不报错)，但无业务逻辑
 *
 * 运行:
 *   node tools/scaffold.js              # 生成缺失模块
 *   node tools/scaffold.js --force      # 强制覆盖已有文件
 *   node tools/scaffold.js --dry-run    # 仅显示要创建的文件，不实际写入
 *
 * 零外部依赖
 * 版本: v1.0 · 2026-07-19
 */

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ---- CLI ----
const FORCE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');
const ROOT = join(process.cwd(), '.');

// ---- 模板定义 ----
// 每个模板: { path, content }
// 内容遵循 architecture-spec.md 的接口契约

const TEMPLATES = [

  // ==================== CORE ====================
  {
    path: 'js/core/engine.js',
    content: `/**
 * WorldEngine — 渲染引擎主循环
 *
 * 架构: 三阶段 init → mount → start
 * 生命周期: 创建 → init → mount → start → update → stop → dispose
 * 配置驱动: 通过 WorldConfig 事件驱动增量更新
 *
 * 版本: v1.0 · 2026-07-19
 * 架构参考: docs/architecture-spec.md 2.3
 */

import { Scene, PerspectiveCamera, WebGLRenderer, ACESFilmicToneMapping, PCFSoftShadowMap } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SceneManager } from './scene.js';
import { CameraSystem } from './camera.js';
import { ClockSystem } from './clock.js';

export class WorldEngine {
  /** @param {HTMLCanvasElement} canvas */
  /** @param {import('../data/world-config.js').WorldConfig} config */
  constructor(canvas, config) {
    this.canvas = canvas;
    this.config = config;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.controls = null;
    this.sceneManager = null;
    this.cameraSystem = null;
    this.clockSystem = null;
    this._running = false;
    this._animFrameId = null;
    this._systems = [];
  }

  /** 初始化渲染器、场景、相机 */
  init() {
    // 渲染器
    this.renderer = new WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.config.get('performance.pixelRatio') || 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.outputColorSpace = 'srgb-linear';

    // 场景
    this.scene = new Scene();
    this.sceneManager = new SceneManager(this);
    this.sceneManager.init(this.scene);

    // 相机
    const fov = this.config.get('camera.fov') || 55;
    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new PerspectiveCamera(fov, aspect, 0.1, 2000);

    // 轨道控制
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = this.config.get('camera.minDistance') || 60;
    this.controls.maxDistance = this.config.get('camera.maxDistance') || 1400;
    this.controls.maxPolarAngle = Math.PI / 2.05;

    // 子系统
    this.cameraSystem = new CameraSystem(this.camera, this.controls, this.config);
    this.clockSystem = new ClockSystem(this.config);

    // 窗口自适应
    this._onResize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    };
    window.addEventListener('resize', this._onResize);

    return this;
  }

  /** 挂载到 DOM */
  mount() {
    // 渲染器已绑定 canvas，无需额外操作
    return this;
  }

  /** 开始动画循环 */
  start() {
    if (this._running) return;
    this._running = true;
    this._loop(0);
    return this;
  }

  /** 停止动画循环 */
  stop() {
    this._running = false;
    if (this._animFrameId !== null) {
      cancelAnimationFrame(this._animFrameId);
      this._animFrameId = null;
    }
    return this;
  }

  /** 完全重建世界 */
  rebuild() {
    this.stop();
    this._disposeScene();
    this.sceneManager = new SceneManager(this);
    this.sceneManager.init(this.scene);
    this.start();
    return this;
  }

  /** 增量配置更新 */
  applyConfig(delta) {
    this.config.merge(delta);
    return this;
  }

  /** 注册系统到帧循环 */
  registerSystem(system) {
    this._systems.push(system);
    return this;
  }

  /** 释放所有资源 */
  dispose() {
    this.stop();
    this._disposeScene();
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
    this.renderer = null;
    this.scene = null;
    this.camera = null;
  }

  // ---- 内部 ----

  _loop(time) {
    if (!this._running) return;
    this._animFrameId = requestAnimationFrame((t) => this._loop(t));

    const dt = this.clockSystem.tick(time);
    this.cameraSystem.update(dt);
    this.controls.update();

    // 系统更新
    for (const sys of this._systems) {
      if (typeof sys.update === 'function') sys.update(dt);
    }

    this.renderer.render(this.scene, this.camera);
  }

  _disposeScene() {
    if (!this.scene) return;
    this.scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) {
          obj.material.forEach(m => m.dispose());
        } else {
          obj.material.dispose();
        }
      }
    });
    while (this.scene.children.length > 0) {
      this.scene.remove(this.scene.children[0]);
    }
  }
}
`,
  },

  {
    path: 'js/core/scene.js',
    content: `/**
 * SceneManager — 场景管理
 *
 * 职责: 场景图分层管理、图层创建/销毁/重建
 * 原则: 所有对象按图层分组，不直接 scene.add
 *
 * 版本: v1.0 · 2026-07-19
 */

import { Group } from 'three';

export class SceneManager {
  /** @param {import('./engine.js').WorldEngine} engine */
  constructor(engine) {
    this.engine = engine;
    this.scene = null;
    this._layers = new Map();
  }

  /** @param {import('three').Scene} scene */
  init(scene) {
    this.scene = scene;
    // 创建默认图层
    this.addLayer('terrain', new Group());
    this.addLayer('buildings', new Group());
    this.addLayer('water', new Group());
    this.addLayer('vegetation', new Group());
    this.addLayer('fx', new Group());
    this.addLayer('sky', new Group());
    this.addLayer('lights', new Group());
    return this;
  }

  /** @param {string} name */
  /** @param {import('three').Group} group */
  addLayer(name, group) {
    if (this._layers.has(name)) {
      console.warn('[SceneManager] 图层已存在，覆盖:', name);
      this.removeLayer(name);
    }
    group.name = name;
    this._layers.set(name, group);
    if (this.scene) this.scene.add(group);
    return this;
  }

  /** @param {string} name */
  removeLayer(name) {
    const group = this._layers.get(name);
    if (group && this.scene) {
      this._disposeGroup(group);
      this.scene.remove(group);
    }
    this._layers.delete(name);
    return this;
  }

  /** @param {string} name */
  /** @returns {import('three').Group | null} */
  getLayer(name) {
    return this._layers.get(name) || null;
  }

  clear() {
    for (const [name] of this._layers) {
      this.removeLayer(name);
    }
    return this;
  }

  _disposeGroup(group) {
    group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) {
          obj.material.forEach(m => m.dispose());
        } else {
          obj.material.dispose();
        }
      }
    });
  }
}
`,
  },

  {
    path: 'js/core/camera.js',
    content: `/**
 * CameraSystem — 相机系统（三模式管理）
 *
 * 模式: orbit → FlyControls → firstPerson
 * 通过 config.camera.mode 切换，支持平滑过渡
 *
 * 版本: v1.0 · 2026-07-19
 */

import { Vector3 } from 'three';

export class CameraSystem {
  /**
   * @param {import('three').PerspectiveCamera} camera
   * @param {import('three/addons/controls/OrbitControls.js').OrbitControls} controls
   * @param {import('../data/world-config.js').WorldConfig} config
   */
  constructor(camera, controls, config) {
    this.camera = camera;
    this.controls = controls;
    this.config = config;
    this._mode = config.get('camera.mode') || 'orbit';
    this._flyProgress = 0;
    this._flyPoints = this._generateFlyPath();
    this._isFirstPerson = false;
    this._keys = { w: false, a: false, s: false, d: false };
    this._euler = { x: 0, y: 0 };

    // 初始相机位置
    this.camera.position.set(400, 250, 400);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  /** @param {'orbit'|'fly'|'firstPerson'} mode */
  setMode(mode) {
    if (mode === this._mode) return;
    this._mode = mode;

    // 退出当前模式清理
    if (mode !== 'firstPerson') {
      this._isFirstPerson = false;
    }
    if (mode !== 'fly') {
      this._flyProgress = 0;
    }

    this.controls.enabled = (mode === 'orbit');
  }

  get mode() { return this._mode; }

  update(dt) {
    if (this._mode === 'fly') {
      this._updateFly(dt);
    } else if (this._mode === 'firstPerson') {
      this._updateFirstPerson(dt);
    }
  }

  /** 重置相机位置 */
  reset() {
    this.camera.position.set(400, 250, 400);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  /** 生成飞行路径 */
  _generateFlyPath() {
    const points = [];
    const radius = this.config.get('camera.flyRadius') || 460;
    const height = this.config.get('camera.flyHeight') || 180;
    const segments = 200;
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const angle = t * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const y = height + Math.sin(angle * 2) * 30;
      points.push(new Vector3(x, y, z));
    }
    return points;
  }

  _updateFly(dt) {
    this._flyProgress += dt * 0.05;
    if (this._flyProgress >= 1) this._flyProgress -= 1;
    const idx = this._flyProgress * (this._flyPoints.length - 1);
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, this._flyPoints.length - 1);
    const frac = idx - i0;
    this.camera.position.lerpVectors(this._flyPoints[i0], this._flyPoints[i1], frac);
    // 看向原点
    this.camera.lookAt(0, 0, 0);
  }

  _updateFirstPerson(dt) {
    const speed = 80;
    const dir = new Vector3();
    this.camera.getWorldDirection(dir);
    const right = new Vector3();
    right.crossVectors(dir, this.camera.up).normalize();
    const forward = new Vector3(dir.x, 0, dir.z).normalize();
    const move = new Vector3();
    if (this._keys.w) move.add(forward);
    if (this._keys.s) move.sub(forward);
    if (this._keys.a) move.sub(right);
    if (this._keys.d) move.add(right);
    if (move.length() > 0) {
      move.normalize().multiplyScalar(speed * dt);
      this.camera.position.add(move);
      this.controls.target.add(move);
    }
  }
}
`,
  },

  {
    path: 'js/core/clock.js',
    content: `/**
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
`,
  },

  // ==================== WORLD ====================
  {
    path: 'js/world/terrain.js',
    content: `/**
 * TerrainGenerator — 地形生成
 *
 * 架构: generate() 返回地形数据 → toMesh() 转为 Three.js 网格
 * 策略: 多频 sin/cos 叠加或 value noise，中心下沉为海盆
 *
 * 版本: v1.0 · 2026-07-19
 */

import { PlaneGeometry, MeshStandardMaterial } from 'three';

export class TerrainGenerator {
  /** @param {import('../data/world-config.js').WorldConfig} config */
  constructor(config) {
    this.config = config;
  }

  /** 生成地形数据 */
  generate() {
    const size = this.config.get('terrain.size') || 900;
    const segments = this.config.get('terrain.segments') || 120;
    const amplitude = this.config.get('terrain.amplitude') || 6;
    return { size, segments, amplitude, heightMap: [] };
  }

  /** 地形数据 → 网格 */
  toMesh(/* data */) {
    const geometry = new PlaneGeometry(900, 900, 120, 120);
    geometry.rotateX(-Math.PI / 2);
    const material = new MeshStandardMaterial({ color: 0x4a7c59, roughness: 0.9, metalness: 0.0 });
    return { geometry, material };
  }
}
`,
  },

  {
    path: 'js/world/city.js',
    content: `/**
 * CityGenerator — 城市建筑生成
 *
 * 架构: generate() 返回 CityData → toMesh() 转为 Three.js 网格组
 * 数据驱动: 密度/高度/夸张系数由配置控制
 *
 * 版本: v1.0 · 2026-07-19
 */

import { Group, BoxGeometry, MeshStandardMaterial, CanvasTexture } from 'three';

export class CityGenerator {
  /** @param {import('../data/world-config.js').WorldConfig} config */
  constructor(config) {
    this.config = config;
  }

  /** 生成城市数据 */
  generate() {
    const density = this.config.get('city.density') || 0.7;
    const exaggeration = this.config.get('city.exaggeration') || 1.0;
    return { buildings: [], density, exaggeration };
  }

  /** 城市数据 → 网格组 */
  toMesh(/* data */) {
    const group = new Group();
    group.name = 'city';
    return group;
  }

  /** 程序化窗户纹理 */
  makeWindowTexture() {
    return new CanvasTexture(document.createElement('canvas'));
  }
}
`,
  },

  {
    path: 'js/world/flora.js',
    content: `/**
 * FloraGenerator — 植被系统
 *
 * 生成: 低多边形树、InstancedMesh 草丛、道路网络
 * 策略: 确定性种子可复现
 *
 * 版本: v1.0 · 2026-07-19
 */

import { Group, CylinderGeometry, IcosahedronGeometry, MeshStandardMaterial } from 'three';

export class FloraGenerator {
  /** @param {import('../data/world-config.js').WorldConfig} config */
  constructor(config) {
    this.config = config;
  }

  /** 生成树木网格 */
  generateTrees() {
    const group = new Group();
    group.name = 'trees';
    return group;
  }

  /** 生成草丛 */
  generateGrass() {
    return new Group();
  }

  /** 生成道路 */
  generateRoads() {
    return new Group();
  }
}
`,
  },

  {
    path: 'js/world/water.js',
    content: `/**
 * WaterGenerator — 水体/水面
 *
 * 实现: 半透明 ShaderMaterial + sin 扰动法线
 * 生命周期: 与场景管理器绑定，重建时自动 dispose
 *
 * 版本: v1.0 · 2026-07-19
 */

import { PlaneGeometry, ShaderMaterial, DoubleSide } from 'three';

export class WaterGenerator {
  /** @param {import('../data/world-config.js').WorldConfig} config */
  constructor(config) {
    this.config = config;
  }

  /** 生成水面网格 */
  generate() {
    return null; // 待实现
  }
}
`,
  },

  {
    path: 'js/world/fx.js',
    content: `/**
 * FXSystem — 粒子/特效系统
 *
 * 职责: 粒子特效、后期处理、装饰性视觉效果
 * 性能: 粒子数 ≤ 2000，支持性能降级
 *
 * 版本: v1.0 · 2026-07-19
 */

import { Points, PointsMaterial, BufferGeometry } from 'three';

export class FXSystem {
  /** @param {import('../data/world-config.js').WorldConfig} config */
  constructor(config) {
    this.config = config;
  }

  /** 初始化粒子系统 */
  init() {
    return null; // 待实现
  }

  /** @param {number} dt */
  update(dt) {
    // 粒子动画更新
  }
}
`,
  },

  // ==================== SYSTEMS ====================
  {
    path: 'js/systems/light.js',
    content: `/**
 * LightSystem — 光照系统
 *
 * 职责: 方向光(太阳)、环境光、半球光，时刻驱动
 * 太阳位置随 config.time.hour 联动
 *
 * 版本: v1.0 · 2026-07-19
 */

import { DirectionalLight, AmbientLight, HemisphereLight, Group } from 'three';

export class LightSystem {
  /** @param {import('../data/world-config.js').WorldConfig} config */
  constructor(config) {
    this.config = config;
    this.group = new Group();
    this.group.name = 'lights';
    this.sunLight = null;
    this.ambientLight = null;
    this.hemisphereLight = null;
  }

  /** 初始化光照 */
  init() {
    this.sunLight = new DirectionalLight(0xffffff, 1.2);
    this.sunLight.position.set(300, 400, 200);
    this.sunLight.castShadow = true;
    this.group.add(this.sunLight);

    this.ambientLight = new AmbientLight(0x404060, 0.4);
    this.group.add(this.ambientLight);

    this.hemisphereLight = new HemisphereLight(0x87ceeb, 0x3a7d44, 0.6);
    this.group.add(this.hemisphereLight);

    return this.group;
  }

  /** @param {number} hour */
  applyTime(hour) {
    // 时刻驱动光照方向/强度
  }
}
`,
  },

  {
    path: 'js/systems/sky.js',
    content: `/**
 * SkySystem — 天空系统
 *
 * 职责: 渐变天空球、太阳精灵、夜晚星空 Points
 * 时刻驱动颜色平滑过渡
 *
 * 版本: v1.0 · 2026-07-19
 */

import { Mesh, SphereGeometry, ShaderMaterial, BackSide, Group, Sprite, SpriteMaterial, Points, PointsMaterial, BufferGeometry } from 'three';

export class SkySystem {
  /** @param {import('../data/world-config.js').WorldConfig} config */
  constructor(config) {
    this.config = config;
    this.group = new Group();
    this.skyMesh = null;
    this.sunSprite = null;
    this.stars = null;
  }

  /** 初始化天空 */
  init() {
    // 天空球
    const geo = new SphereGeometry(900, 32, 32);
    const mat = new ShaderMaterial({ side: BackSide });
    this.skyMesh = new Mesh(geo, mat);
    this.group.add(this.skyMesh);

    return this.group;
  }

  /** @param {number} hour */
  applyTime(hour) {
    // 时刻驱动天空颜色
  }
}
`,
  },

  {
    path: 'js/systems/fog.js',
    content: `/**
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
`,
  },

  {
    path: 'js/systems/shadow.js',
    content: `/**
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
`,
  },

  // ==================== UI ====================
  {
    path: 'js/ui/panel.js',
    content: `/**
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
`,
  },

  {
    path: 'js/ui/hud.js',
    content: `/**
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
`,
  },

  // ==================== APP ====================
  {
    path: 'js/app.js',
    content: `/**
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
`,
  },
];

// ---- 执行 ----
let created = 0;
let skipped = 0;

for (const tpl of TEMPLATES) {
  const fullPath = join(ROOT, tpl.path);
  const dir = dirname(fullPath);

  if (!DRY_RUN && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const isMissing = !existsSync(fullPath);
  if (isMissing || FORCE) {
    if (DRY_RUN) {
      console.log(`  📄 创建: ${tpl.path}`);
      created++;
    } else {
      writeFileSync(fullPath, tpl.content, 'utf-8');
      console.log(`  ✅ 创建: ${tpl.path}`);
      created++;
    }
  } else {
    if (DRY_RUN) {
      console.log(`  ⏩ 已存在: ${tpl.path}`);
    }
    skipped++;
  }
}

console.log(`\n  📊 结果: 创建 ${created} 个文件, 跳过 ${skipped} 个\n`);