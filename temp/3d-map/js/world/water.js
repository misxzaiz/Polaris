/**
 * WaterGenerator — 波动水面（ShaderMaterial）
 * 半透明 + sin 扰动法线，不与地形 Z-fighting
 */
import * as THREE from 'three';

const WATER_UNIFORMS = {
  time: { value: 0 },
  waterColor: { value: new THREE.Color(0x1a4a6a) },
  deepColor: { value: new THREE.Color(0x0a2030) },
  opacity: { value: 0.65 },
  foamColor: { value: new THREE.Color(0xa0c8d8) },
};

const WATER_VERTEX = `
  uniform float time;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec2 vUv;

  void main() {
    vUv = uv;
    vec3 p = position;
    float w1 = sin(p.x * 0.04 + time * 0.8) * cos(p.z * 0.05 + time * 0.6);
    float w2 = sin(p.x * 0.09 - time * 1.1) * sin(p.z * 0.07 + time * 0.9);
    p.y += w1 * 0.35 + w2 * 0.2;

    float e = 0.5;
    float dx = sin((p.x + e) * 0.04 + time * 0.8) * cos(p.z * 0.05 + time * 0.6)
             + sin((p.x + e) * 0.09 - time * 1.1) * sin(p.z * 0.07 + time * 0.9);
    float dz = sin(p.x * 0.04 + time * 0.8) * cos((p.z + e) * 0.05 + time * 0.6)
             + sin(p.x * 0.09 - time * 1.1) * sin((p.z + e) * 0.07 + time * 0.9);
    vNormal = normalize(vec3(-(dx - w1) / e, 1.0, -(dz - w1) / e));

    vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const WATER_FRAGMENT = `
  uniform vec3 waterColor;
  uniform vec3 deepColor;
  uniform vec3 foamColor;
  uniform float time;
  varying vec3 vNormal;
  varying vec3 vWorld;
  varying vec2 vUv;

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(cameraPosition - vWorld);
    float wave = sin(vWorld.x * 0.06 + time * 1.5) * cos(vWorld.z * 0.05 - time * 1.2);
    vec3 baseColor = mix(deepColor, waterColor, 0.5 + wave * 0.5);
    float spec = pow(max(dot(N, V), 0.0), 20.0);
    float dist = length(vUv - 0.5) * 2.0;
    float foam = smoothstep(0.85, 1.0, dist) * 0.4;
    vec3 col = baseColor + vec3(0.9) * spec * 0.5 + foamColor * foam;
    gl_FragColor = vec4(col, opacity);
  }
`;

export class WaterGenerator {
  #mesh;
  #level = 0;

  /** @param {import('../data/world-config.js').WorldConfig} config */
  constructor(config) { this.config = config; }

  setLevel(v) { this.#level = v; }

  generate(size = 1100) {
    const geo = new THREE.PlaneGeometry(size, size, 80, 80);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: WATER_UNIFORMS,
      vertexShader: WATER_VERTEX,
      fragmentShader: WATER_FRAGMENT,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.#mesh = new THREE.Mesh(geo, mat);
    this.#mesh.position.y = this.#level + 0.05;
    this.#mesh.renderOrder = 1;
    this.#mesh.name = 'water';
    return this.#mesh;
  }

  get mesh() { return this.#mesh; }

  update(dt) {
    if (this.#mesh?.material) {
      this.#mesh.material.uniforms.time.value += dt;
    }
  }

  dispose() {
    if (this.#mesh) {
      this.#mesh.geometry.dispose();
      this.#mesh.material.dispose();
    }
  }
}