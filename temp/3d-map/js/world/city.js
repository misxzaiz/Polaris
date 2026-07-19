/**
 * CityGenerator — 城市建筑群程序化生成
 *
 * 数据驱动：密度/高度/夸张系数由配置控制
 * 网格化分布，CBD 高、外围低，高度梯度着色
 * 程序化窗户纹理（CanvasTexture），夜晚窗户发光
 *
 * @version v1.0 · 2026-07-19
 */
import * as THREE from 'three';

// 颜色调色板
const BUILDING_COLORS = [
  [0x4a6fa5, 0x3a5a8a],  // 蓝灰
  [0x6a7a8a, 0x5a6a7a],  // 灰
  [0x8a7a6a, 0x7a6a5a],  // 暖灰
  [0x3a5a7a, 0x2a4a6a],  // 深蓝
  [0x5a7a8a, 0x4a6a7a],  // 浅灰蓝
  [0x7a6a8a, 0x6a5a7a],  // 灰紫
  [0x4a6a5a, 0x3a5a4a],  // 灰绿
  [0x8a6a5a, 0x7a5a4a],  // 棕色
];

export class CityGenerator {
  /** @param {import('../data/world-config.js').WorldConfig} config */
  constructor(config) {
    this.config = config;
    this.#seed = Date.now();
  }

  #seed;
  #buildings = [];

  setSeed(s) { this.#seed = s; }

  /**
   * 生成城市数据（不操作 Three.js 场景）
   */
  generate() {
    const density = this.config.get('city.density') || 0.7;
    const exaggeration = this.config.get('city.exaggeration') || 1.0;
    const blockSize = this.config.get('city.blockSize') || 18;
    const roadEvery = this.config.get('city.roadEvery') || 4;
    const cbdFactor = this.config.get('city.cbdFactor') || 1.0;
    const terrainAmplitude = this.config.get('terrain.amplitude') || 6;

    // 从配置读取地形尺寸
    const worldSize = 600;
    const half = worldSize / 2;

    // 确定性随机
    const rand = this.#mulberry32(this.#seed);
    const buildings = [];
    const cellSize = blockSize + 2; // 含道路间隙
    const gridSize = Math.floor(worldSize / cellSize);
    const start = -(gridSize * cellSize) / 2;

    // 每 roadEvery 格一条路
    for (let gx = 0; gx < gridSize; gx++) {
      for (let gz = 0; gz < gridSize; gz++) {
        const isRoad = (gx % roadEvery === 0) || (gz % roadEvery === 0);
        if (isRoad) continue;

        if (rand() > density) continue;

        const cx = start + gx * cellSize + cellSize / 2;
        const cz = start + gz * cellSize + cellSize / 2;
        const dist = Math.sqrt(cx * cx + cz * cz);

        // 中心 CBD 高，外围低
        const maxDist = worldSize * 0.5;
        const normDist = dist / maxDist;
        const baseHeight = (1 - normDist) * 60 * cbdFactor + 4;
        const heightJitter = 0.5 + rand() * 0.5;
        let height = baseHeight * heightJitter * exaggeration;

        if (height < 3) height = 3 + rand() * 2;

        // 建筑宽度随高度变化
        const width = 6 + rand() * 6;
        const depth = 6 + rand() * 6;

        // 高度分类
        let type = 'low';
        if (height > 30) type = 'mid';
        if (height > 60) type = 'high';

        // 颜色
        const palette = BUILDING_COLORS[Math.floor(rand() * BUILDING_COLORS.length)];
        const color = palette[0];

        buildings.push({
          id: `b${gx}-${gz}`,
          position: { x: cx, z: cz },
          width,
          depth,
          height,
          type,
          color,
          palette,
        });
      }
    }

    this.#buildings = buildings;
    return { buildings, density, exaggeration };
  }

  /**
   * 城市数据 → 网格组
   * 复用材质，控制 draw call
   */
  toMesh(data) {
    const group = new THREE.Group();
    group.name = 'city';
    const hour = this.config.get('time.hour') || 14;
    const isNight = hour < 7 || hour > 19;

    // 材质缓存：按颜色索引
    const matCache = new Map();
    function getMat(color, needsEmissive) {
      const key = `${color}-${needsEmissive}`;
      if (matCache.has(key)) return matCache.get(key);
      const mat = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.6,
        metalness: 0.2,
      });
      if (needsEmissive) {
        mat.emissive = new THREE.Color(0xffaa33);
        mat.emissiveIntensity = 0.3;
      }
      matCache.set(key, mat);
      return mat;
    }

    // 窗户纹理生成
    const windowTexture = this.#makeWindowTexture();

    for (const b of data.buildings) {
      const geo = new THREE.BoxGeometry(b.width, b.height, b.depth);
      const mat = getMat(b.color, false);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(b.position.x, b.height / 2, b.position.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = b.id;
      mesh.userData = {
        buildingType: b.type,
        height: b.height,
        width: b.width,
        depth: b.depth,
      };

      // 窗纹侧面（仅中高层以上的建筑）
      if (b.height > 10 && windowTexture) {
        const sideMat = new THREE.MeshStandardMaterial({
          map: windowTexture,
          roughness: 0.4,
          metalness: 0.3,
        });
        if (isNight) {
          sideMat.emissive = new THREE.Color(0xffaa33);
          sideMat.emissiveIntensity = 0.15;
          sideMat.emissiveMap = windowTexture;
        }
        // 只替换侧面材质（索引 0,2,3,5, 排除顶底 1,4)
        mesh.material = [
          sideMat, // 右
          mat,     // 顶
          sideMat, // 左
          sideMat, // 前
          mat,     // 底
          sideMat, // 后
        ];
      }

      group.add(mesh);
    }

    // 保存引用用于更新
    this.#group = group;
    this.#matCache = matCache;
    this.#windowTexture = windowTexture;
    this.#isNight = isNight;

    return group;
  }

  /**
   * 更新夜间窗户发光
   */
  updateNightMode(hour) {
    const isNight = hour < 7 || hour > 19;
    if (isNight === this.#isNight) return;
    this.#isNight = isNight;
    if (!this.#group) return;

    this.#group.traverse(obj => {
      if (obj.isMesh && obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (m.map && m.map === this.#windowTexture) {
            m.emissive = isNight ? new THREE.Color(0xffaa33) : new THREE.Color(0x000000);
            m.emissiveIntensity = isNight ? 0.15 : 0;
          }
        }
      }
    });
  }

  getDrawCalls() {
    return this.#group?.children.length || 0;
  }

  dispose() {
    if (this.#group) {
      this.#group.traverse(obj => {
        if (obj.isMesh) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) {
            obj.material.forEach(m => m.dispose());
          } else {
            obj.material.dispose();
          }
        }
      });
      this.#group.children.length = 0;
    }
    if (this.#windowTexture) this.#windowTexture.dispose();
    this.#matCache?.clear();
  }

  // --- 私有 ---

  #group = null;
  #matCache = null;
  #windowTexture = null;
  #isNight = false;

  /**
   * 程序化窗户纹理（CanvasTexture）
   */
  #makeWindowTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    // 背景
    ctx.fillStyle = '#2a3a4a';
    ctx.fillRect(0, 0, 128, 128);

    // 网格窗户
    const cols = 8, rows = 8;
    const cw = 128 / cols, ch = 128 / rows;
    const margin = 2;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (Math.random() > 0.7) {
          // 点亮窗户（夜晚发光）
          ctx.fillStyle = '#ffdd66';
          ctx.globalAlpha = 0.3 + Math.random() * 0.4;
        } else {
          ctx.fillStyle = '#6a8aaa';
          ctx.globalAlpha = 0.5 + Math.random() * 0.3;
        }
        ctx.fillRect(
          c * cw + margin,
          r * ch + margin,
          cw - margin * 2,
          ch - margin * 2
        );
      }
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(4, 4);
    return tex;
  }

  #mulberry32(seed) {
    return function () {
      let t = seed += 0x6D2B79F5;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
}