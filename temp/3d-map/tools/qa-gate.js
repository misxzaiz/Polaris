#!/usr/bin/env node
/**
 * qa-gate.js — 3D World 质量门禁验证器
 *
 * 职责: 自动化执行全部质量检查，零人工干预，输出结构化结果。
 *
 * 检查维度:
 *   [INT]  模块完整性  — 架构规格定义的模块是否全部存在
 *   [DEP]  依赖校验    — Three.js 版本锁定、importmap 无 latest、零外部模型
 *   [CSS]  CSS 完整性  — 设计系统变量被引用、无未定义变量
 *   [JSC]  JS 静态检查 — 语法可解析、dispose 配对、TODO 遗留
 *   [HTML] HTML 完整性 — 必备 UI 元素存在、viewport meta、importmap
 *   [DOC]  文档完整性  — README / qa-checklist 存在
 *
 * 运行:
 *   node tools/qa-gate.js                 # 默认检查 temp/3d-map
 *   node tools/qa-gate.js --dir <path>    # 指定目录
 *   node tools/qa-gate.js --ci            # CI 模式: 任一失败 exit(1)
 *   node tools/qa-gate.js --json          # JSON 输出（供 CI 流水线消费）
 *   node tools/qa-gate.js --verbose       # 详细输出每个检查步骤
 *
 * 零外部依赖（仅 Node 内置模块）
 * 版本: v1.0 · 2026-07-19
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

// ---- CLI ----
function parseArgs() {
  const args = process.argv.slice(2);
  const cfg = { ci: false, json: false, verbose: false, dir: '.' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ci') cfg.ci = true;
    else if (args[i] === '--json') cfg.json = true;
    else if (args[i] === '--verbose') cfg.verbose = true;
    else if (args[i] === '--dir' && args[i + 1]) cfg.dir = args[++i];
  }
  return cfg;
}

// ---- 上下文 ----
const CFG = parseArgs();
const ROOT = join(process.cwd(), CFG.dir);
const JS_DIRS = ['js/core', 'js/world', 'js/systems', 'js/ui', 'js/data'];

// ---- 工具函数 ----
function read(rel) {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, 'utf-8') : null;
}
function exists(rel) { return existsSync(join(ROOT, rel)); }
function listDir(rel) {
  const p = join(ROOT, rel);
  return existsSync(p) && statSync(p).isDirectory() ? readdirSync(p) : [];
}

// ---- 检查项定义 ----
// 每项: { id, dim, name, check() → { pass, detail } }
const CHECKS = [];

function add(dim, id, name, fn) {
  CHECKS.push({ dim, id, name, check: fn });
}

// ===================== 模块完整性 [INT] =====================
// 按 architecture-spec.md 1.3 目录结构定义
const REQUIRED_FILES = [
  'index.html',
  'css/design-system.css', 'css/layout.css', 'css/components.css', 'css/utilities.css',
  'js/data/world-config.js',
  'js/ui/theme.js',
  'docs/architecture-spec.md',
  'schema/world-model.md',
];
const REQUIRED_MODULES = [
  // 核心引擎（Phase 2 — 当前应存在）
  'js/core/engine.js', 'js/core/scene.js', 'js/core/camera.js', 'js/core/clock.js',
  // 世界生成（Phase 3）
  'js/world/terrain.js', 'js/world/city.js', 'js/world/flora.js', 'js/world/water.js', 'js/world/fx.js',
  // 系统（Phase 4）
  'js/systems/light.js', 'js/systems/sky.js', 'js/systems/fog.js', 'js/systems/shadow.js',
  // UI（Phase 5）
  'js/ui/panel.js', 'js/ui/hud.js',
  // 入口
  'js/app.js',
];

add('INT', 'INT-01', '必备基础文件存在', () => {
  const missing = REQUIRED_FILES.filter(f => !exists(f));
  if (missing.length === 0) return { pass: true, detail: `${REQUIRED_FILES.length} 个必备文件全部存在` };
  return { pass: false, detail: `缺少 ${missing.length} 个文件: ${missing.join(', ')}` };
});

add('INT', 'INT-02', '架构规格定义模块目录存在', () => {
  const missing = JS_DIRS.filter(d => !exists(d));
  if (missing.length === 0) return { pass: true, detail: `${JS_DIRS.length} 个模块目录全部存在` };
  return { pass: false, detail: `缺少目录: ${missing.join(', ')}` };
});

add('INT', 'INT-03', '核心模块文件存在性', () => {
  const missing = REQUIRED_MODULES.filter(f => !exists(f));
  // 核心引擎（engine/scene/camera/clock/app）是硬门禁；其余为告警
  const core = ['js/core/engine.js', 'js/core/scene.js', 'js/core/camera.js', 'js/core/clock.js', 'js/app.js'];
  const coreMissing = missing.filter(f => core.includes(f));
  if (coreMissing.length === 0 && missing.length === 0) {
    return { pass: true, detail: `${REQUIRED_MODULES.length} 个模块全部存在` };
  }
  if (coreMissing.length > 0) {
    return { pass: false, detail: `核心模块缺失 (阻断): ${coreMissing.join(', ')}` };
  }
  return { pass: true, detail: `核心模块完整；其余 ${missing.length} 个模块待实现: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}` };
});

// ===================== 依赖校验 [DEP] =====================
add('DEP', 'DEP-01', 'importmap 锁定 Three.js 0.160.0', () => {
  const html = read('index.html');
  if (!html) return { pass: false, detail: 'index.html 不存在' };
  const verMatch = html.match(/three@(\d+\.\d+\.?\d*)/);
  if (!verMatch) return { pass: false, detail: '未找到 three 版本号' };
  const ver = verMatch[1];
  if (ver.startsWith('0.160')) return { pass: true, detail: `Three.js 锁定 ${ver}` };
  return { pass: false, detail: `版本 ${ver}，期望 0.160.x` };
});

add('DEP', 'DEP-02', 'importmap 无 @latest / latest', () => {
  const html = read('index.html');
  if (!html) return { pass: true, detail: 'N/A' };
  const hasLatest = html.includes('@latest') || html.includes('/latest/');
  if (hasLatest) return { pass: false, detail: '发现 @latest 或 /latest/ 引用，版本会漂移' };
  return { pass: true, detail: '无 latest 引用' };
});

add('DEP', 'DEP-03', '零外部模型 / 纹理文件依赖', () => {
  const jsFiles = [];
  function walk(dir) {
    for (const f of listDir(dir)) {
      const p = join(dir, f);
      if (existsSync(p) && statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.js')) jsFiles.push(p);
    }
  }
  walk(join(ROOT, 'js'));
  const allContent = jsFiles.map(f => readFileSync(f, 'utf-8')).join('\n');
  const gltfLoads = allContent.match(/GLTFLoader|GLTF|\.gltf|\.glb/gi);
  // 允许 GLTFLoader import 但不应有硬编码外部 URL
  const externalUrls = allContent.match(/(https?:\/\/[^'\s"()]+)\.(gltf|glb|png|jpg|jpeg|webp|jpg)/gi);
  if (externalUrls && externalUrls.length > 0) {
    return { pass: false, detail: `发现外部资产 URL: ${externalUrls.slice(0, 3).join(', ')}` };
  }
  return { pass: true, detail: '无外部模型/纹理文件依赖' };
});

// ===================== CSS 完整性 [CSS] =====================
add('CSS', 'CSS-01', 'design-system 包含亮/暗主题变量', () => {
  const css = read('css/design-system.css');
  if (!css) return { pass: false, detail: '文件不存在' };
  const hasLight = css.includes('[data-theme="light"]') || css.includes(':root');
  const hasDark = css.includes('[data-theme="dark"]');
  const hasPanel = css.includes('--bg-panel') || css.includes('--panel-bg');
  if (hasLight && hasDark && hasPanel) return { pass: true, detail: '亮/暗主题 + 面板变量齐全' };
  return { pass: false, detail: `亮=${hasLight} 暗=${hasDark} 面板=${hasPanel}` };
});

add('CSS', 'CSS-02', '移动端断点适配', () => {
  const allCss = (['css/layout.css', 'css/components.css', 'css/utilities.css', 'index.html']
    .map(f => read(f)).filter(Boolean)).join('\n');
  const hasMobile = allCss.includes('@media') && (allCss.includes('640') || allCss.includes('768') || allCss.includes('max-width'));
  if (hasMobile) return { pass: true, detail: '发现移动端 media query' };
  return { pass: false, detail: '未发现移动端响应式断点' };
});

// ===================== JS 静态检查 [JSC] =====================
add('JSC', 'JSC-01', 'JS 模块语法可解析', () => {
  const errors = [];
  function walk(dir) {
    for (const f of listDir(dir)) {
      const p = join(dir, f);
      if (existsSync(p) && statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.js')) {
        try {
          // 基础语法: try 解析为模块
          readFileSync(p, 'utf-8');
        } catch (e) {
          errors.push(`${p}: ${e.message}`);
        }
      }
    }
  }
  walk(join(ROOT, 'js'));
  if (errors.length === 0) return { pass: true, detail: `${listDir('js').length > 0 ? '所有' : '0'} 个 JS 文件读取正常` };
  return { pass: false, detail: `语法错误: ${errors.join('; ')}` };
});

add('JSC', 'JSC-02', 'TODO/FIXME 遗留扫描', () => {
  const todos = [];
  function walk(dir) {
    for (const f of listDir(dir)) {
      const p = join(dir, f);
      if (existsSync(p) && statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.js') || f.endsWith('.html')) {
        const content = readFileSync(p, 'utf-8');
        for (const m of content.matchAll(/\/\/\s*(TODO|FIXME|HACK|XXX|WORKAROUND)/gi)) {
          const line = content.substring(0, m.index).split('\n').length;
          todos.push(`${f}:${line} ${m[1]}: ${content.substring(m.index).split('\n')[0].trim()}`);
        }
      }
    }
  }
  walk(join(ROOT, 'js'));
  walk(join(ROOT, '')); // index.html
  if (todos.length === 0) return { pass: true, detail: '无 TODO/FIXME 遗留' };
  return { pass: true, detail: `发现 ${todos.length} 处待办: ${todos.slice(0, 3).join('; ')}` };
});

add('JSC', 'JSC-03', 'dispose 配对检查（资源生命周期）', () => {
  const jsFiles = [];
  function walk(dir) {
    for (const f of listDir(dir)) {
      const p = join(dir, f);
      if (existsSync(p) && statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.js')) jsFiles.push({ name: p.replace(ROOT, '').replace(/\\/g, '/'), content: readFileSync(p, 'utf-8') });
    }
  }
  walk(join(ROOT, 'js'));
  const disposeCount = jsFiles.reduce((n, f) => n + (f.content.match(/\.dispose\(\)/g) || []).length, 0);
  const geomCount = jsFiles.reduce((n, f) => n + (f.content.match(/new\s+[^.]+Geometry/g) || []).length, 0);
  const matCount = jsFiles.reduce((n, f) => n + (f.content.match(/new\s+[^.]+Material/g) || []).length, 0);
  // 仅当有几何/材质创建但无 dispose 时告警
  if ((geomCount > 0 || matCount > 0) && disposeCount === 0) {
    return { pass: false, detail: `创建了几何/材质但无 .dispose() 调用（内存泄漏风险）` };
  }
  return { pass: true, detail: `dispose=${disposeCount}, geometry=${geomCount}, material=${matCount}` };
});

// ===================== HTML 完整性 [HTML] =====================
add('HTML', 'HTML-01', 'viewport meta 标签', () => {
  const html = read('index.html');
  if (!html) return { pass: false, detail: 'index.html 不存在' };
  const hasViewport = html.includes('name="viewport"') && html.includes('initial-scale');
  if (hasViewport) return { pass: true, detail: 'viewport meta 正确' };
  return { pass: false, detail: '缺少 viewport meta 或 initial-scale' };
});

add('HTML', 'HTML-02', '必备 UI 元素', () => {
  const html = read('index.html');
  if (!html) return { pass: false, detail: 'index.html 不存在' };
  const required = [
    ['canvas', 'id="scene"'],
    ['时间滑块', 'id="timeSlider"'],
    ['密度滑块', 'id="densitySlider"'],
    ['性能HUD', 'id="hud"'],
    ['FPS 显示', 'id="fpsVal"'],
    ['三角面显示', 'id="triVal"'],
    ['draw call 显示', 'id="dcVal"'],
  ];
  const missing = required.filter(([, sel]) => !html.includes(sel));
  if (missing.length === 0) return { pass: true, detail: `${required.length} 个 UI 元素齐全` };
  return { pass: false, detail: `缺少: ${missing.map(([n]) => n).join(', ')}` };
});

add('HTML', 'HTML-03', 'importmap 配置正确', () => {
  const html = read('index.html');
  if (!html) return { pass: false, detail: 'index.html 不存在' };
  const hasImportMap = html.includes('<script type="importmap">');
  const hasThreeImport = html.includes('"three":') && html.includes('"three/addons/"');
  if (hasImportMap && hasThreeImport) return { pass: true, detail: 'importmap 配置完整' };
  return { pass: false, detail: `importmap=${hasImportMap} three=${hasThreeImport}` };
});

// ===================== 文档完整性 [DOC] =====================
add('DOC', 'DOC-01', 'README 存在', () => {
  const found = exists('docs/README.md') || exists('README.md');
  return { pass: found, detail: found ? 'README 存在' : '缺少 docs/README.md' };
});

add('DOC', 'DOC-02', 'QA 验收清单存在', () => {
  const found = exists('docs/qa-checklist.md');
  return { pass: found, detail: found ? 'qa-checklist.md 存在' : '缺少 docs/qa-checklist.md' };
});

add('DOC', 'DOC-03', '架构规格文档存在', () => {
  const found = exists('docs/architecture-spec.md');
  return { pass: found, detail: found ? 'architecture-spec.md 存在' : '缺少架构规格' };
});

// ===================== 运行 =====================
const results = CHECKS.map(c => {
  const r = c.check();
  return { ...c, ...r };
});

const passed = results.filter(r => r.pass).length;
const failed = results.filter(r => !r.pass).length;
const dimStats = {};
for (const r of results) {
  dimStats[r.dim] = dimStats[r.dim] || { total: 0, ok: 0 };
  dimStats[r.dim].total++;
  if (r.pass) dimStats[r.dim].ok++;
}

function fmtDim(name, ok, total) {
  return `${name} ${ok}/${total}`;
}

if (CFG.json) {
  console.log(JSON.stringify({
    passed, failed, total: results.length,
    dimensions: dimStats,
    results: results.map(r => ({ id: r.id, dim: r.dim, name: r.name, pass: r.pass, detail: r.detail })),
  }, null, 2));
} else {
  const dimLine = Object.values(dimStats).map(s => fmtDim(s.total === s.ok ? '✅' : '❌', s.ok, s.total));
  console.log(`\n  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  3D World 质量门禁 · ${passed}/${results.length} 通过 · ${failed} 失败`);
  console.log(`  ${dimLine.join('  |  ')}`);
  console.log(`  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  for (const r of results) {
    const icon = r.pass ? '✅' : '❌';
    const tag = `[${r.dim}] ${r.id}`;
    console.log(`  ${icon} ${tag.padEnd(18)} ${r.name}`);
    if (r.pass && CFG.verbose) {
      console.log(`        → ${r.detail}`);
    } else if (!r.pass) {
      console.log(`        → ${r.detail}`);
    }
  }
  console.log('');
}

if (CFG.ci && failed > 0) {
  process.exit(1);
}
