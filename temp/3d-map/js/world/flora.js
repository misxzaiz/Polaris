/**
 * FloraGenerator — 植被系统（树木 / 草丛 / 道路）
 *
 * 生成: 低多边形树、InstancedMesh 草丛、道路网络
 * 策略: 确定性种子可复现
 *
 * @version v1.0 · 2026-07-19
 */
import * as THREE from 'three';

export class FloraGenerator {
  /** @param {import('../data/world-config.js').WorldConfig} config */
  constructor(config) { this.config = config; }

  #group = null;
  #grass = null;

  /**
   * 生成树木
   * - 树干：CylinderGeometry
   * - 树冠：IcosahedronGeometry（flatShading）
   */
  generateTrees(terrain, opts = {}) {
    const group = new THREE.Group();
    group.name = 'trees';
    const density = opts.density ?? 0.6;
    const count = opts.count ?? 80;
    const rand = this.#mulberry32(opts.seed ?? 42);
    const worldSize = 600;
    const half = worldSize / 2;

    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a3a1a, roughness: 0.9 });
    const crownMat = new THREE.MeshStandardMaterial({
      color: 0x2f6a2a,
      roughness: 0.85,
      flatShading: true,
    });
    const crownMat2 = new THREE.MeshStandardMaterial({
      color: 0x4a8a3a,
      roughness: 0.85,
      flatShading: true,
    });

    for (let i = 0; i < count; i++) {
      const x = (rand() - 0.5) * worldSize;
      const z = (rand() - 0.5) * worldSize;
      // 不放在市中心（留给建筑）
      const dist = Math.sqrt(x * x + z * z);
      if (dist < 80) continue;

      // 贴附地形高度
      const baseY = terrain.heightAt(x, z) || 0;
      if (baseY < -0.3) continue; // 跳过水下

      const scale = 0.7 + rand() * 0.8;
      const trunkH = 2.5 * scale;

      // 树干
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3 * scale, 0.4 * scale, trunkH, 6),
        trunkMat
      );
      trunk.position.set(x, baseY + trunkH / 2, z);
      trunk.castShadow = true;

      // 树冠
      const crown = new THREE.Mesh(
        new THREE.IcosahedronGeometry(2 * scale, 0),
        rand() > 0.5 ? crownMat : crownMat2
      );
      crown.position.set(x, baseY + trunkH + 1.2 * scale, z);
      crown.castShadow = true;
      crown.receiveShadow = true;

      group.add(trunk);
      group.add(crown);
    }

    this.#group = group;
    return group;
  }

  /**
   * 生成草丛（InstancedMesh）
   */
  generateGrass(terrain, opts = {}) {
    const count = opts.count ?? 800;
    const rand = this.#mulberry32(opts.seed ?? 123);
    const worldSize = 600;
    const half = worldSize / 2;

    const bladeGeo = new THREE.ConeGeometry(0.3, 1.2, 4);
    const bladeMat = new THREE.MeshStandardMaterial({
      color: 0x5a9a3a,
      roughness: 0.9,
      flatShading: true,
    });

    const grass = new THREE.InstancedMesh(bladeGeo, bladeMat, count);
    grass.name = 'grass';
    grass.receiveShadow = true;

    const dummy = new THREE.Object3D();
    let placed = 0;
    while (placed < count) {
      const x = (rand() - 0.5) * worldSize;
      const z = (rand() - 0.5) * worldSize;
      const baseY = terrain.heightAt(x, z) || 0;
      if (baseY < 0) continue; // 不放在水下
      if (baseY > 10) continue; // 不放在高山

      dummy.position.set(x, baseY + 0.6, z);
      dummy.scale.setScalar(0.6 + rand() * 0.8);
      dummy.rotation.y = rand() * Math.PI;
      dummy.updateMatrix();
      grass.setMatrixAt(placed, dummy.matrix);
      placed++;
    }
    grass.count = placed;
    grass.instanceMatrix.needsUpdate = true;

    this.#grass = grass;
    return grass;
  }

  /**
   * 生成道路网络（PlaneGeometry，贴于地面）
   */
  generateRoads(terrain, opts = {}) {
    const group = new THREE.Group();
    group.name = 'roads';
    const roadEvery = this.config.get('city.roadEvery') || 4;
    const blockSize = this.config.get('city.blockSize') || 18;
    const worldSize = 600;
    const half = worldSize / 2;
    const cellSize = blockSize + 2;
    const gridSize = Math.floor(worldSize / cellSize);
    const start = -(gridSize * cellSize) / 2;

    const roadMat = new THREE.MeshStandardMaterial({
      color: 0x333340,
      roughness: 0.95,
      metalness: 0.0,
    });
    const lineMat = new THREE.MeshStandardMaterial({
      color: 0xcccc44,
      roughness: 0.8,
    });

    // 主干道（每隔 roadEvery 格一条）
    for (let i = 0; i < gridSize; i++) {
      if (i % roadEvery !== 0) continue;
      const t = start + i * cellSize;
      // X 方向路
      const roadX = new THREE.Mesh(
        new THREE.PlaneGeometry(worldSize, cellSize),
        roadMat
      );
      roadX.rotation.x = -Math.PI / 2;
      roadX.position.set(0, 0.02, t);
      roadX.receiveShadow = true;
      group.add(roadX);

      // Z 方向路
      const roadZ = new THREE.Mesh(
        new THREE.PlaneGeometry(cellSize, worldSize),
        roadMat
      );
      roadZ.rotation.x = -Math.PI / 2;
      roadZ.position.set(t, 0.02, 0);
      roadZ.receiveShadow = true;
      group.add(roadZ);
    }

    return group;
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
    if (this.#grass) {
      this.#grass.geometry.dispose();
      this.#grass.material.dispose();
    }
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