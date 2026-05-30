/* eslint-disable no-console */
// @ts-check
/**
 * Polaris Web 一键打包脚本（跨平台）
 *
 * 行为：
 *   1. 执行 `pnpm run build:web`（编译前端 dist + 当前平台 polaris-web 二进制）
 *   2. 创建干净的输出目录 `polaris-web/`
 *   3. 按当前平台拷贝二进制 + dist/ 到输出目录
 *   4. 生成与当前平台匹配的启动脚本（Windows: start.bat / Linux·macOS: start.sh）
 *
 * 用法：
 *   node scripts/package-web.mjs              # 完整打包（编译 + 打包）
 *   node scripts/package-web.mjs --no-build   # 跳过编译，仅用现有产物重新打包
 *
 * ⚠️ 重要：编译出的二进制是「当前平台专用」的，不能跨平台复制。
 *    想在 Linux 上运行，请把源码放到 Linux/WSL 上再次运行本脚本。
 */

import { execSync } from 'node:child_process';
import {
  existsSync,
  rmSync,
  mkdirSync,
  cpSync,
  copyFileSync,
  writeFileSync,
  chmodSync,
  statSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const isWindows = process.platform === 'win32';
const binName = isWindows ? 'polaris-web.exe' : 'polaris-web';
const skipBuild = process.argv.slice(2).includes('--no-build');

const C = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};
const log = (m) => console.log(`${C.cyan}[package-web]${C.reset} ${m}`);
const ok = (m) => console.log(`${C.green}[package-web]${C.reset} ${m}`);
const warn = (m) => console.warn(`${C.yellow}[package-web]${C.reset} ${m}`);
const fail = (m) => {
  console.error(`${C.red}[package-web]${C.reset} ${m}`);
  process.exit(1);
};

const distDir = join(root, 'dist');
const binSrc = join(root, 'src-tauri', 'target', 'release', binName);
const outDir = join(root, 'polaris-web');

// ---------------------------------------------------------------------------
// 1. 编译
// ---------------------------------------------------------------------------
if (skipBuild) {
  warn('已指定 --no-build：跳过编译，直接打包现有产物。');
} else {
  log('开始编译（pnpm run build:web）……');
  log('包含前端构建 + Rust release 编译，首次构建可能需要数分钟，请耐心等待。');
  try {
    execSync('pnpm run build:web', { cwd: root, stdio: 'inherit', shell: true });
  } catch {
    fail('编译失败，请查看上方错误输出后重试。');
  }
  ok('编译完成。');
}

// ---------------------------------------------------------------------------
// 2. 校验产物
// ---------------------------------------------------------------------------
if (!existsSync(binSrc)) {
  fail(`未找到二进制：${binSrc}\n  请去掉 --no-build 重新运行，让脚本先完成编译。`);
}
if (!existsSync(join(distDir, 'index.html'))) {
  fail(`未找到前端产物：${join(distDir, 'index.html')}\n  请确认 vite build 是否成功。`);
}

// ---------------------------------------------------------------------------
// 3. 重建输出目录
// ---------------------------------------------------------------------------
if (existsSync(outDir)) {
  log(`清理旧的输出目录：${outDir}`);
  rmSync(outDir, { recursive: true, force: true });
}
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// 4. 拷贝二进制 + dist
// ---------------------------------------------------------------------------
log('拷贝二进制……');
copyFileSync(binSrc, join(outDir, binName));
if (!isWindows) chmodSync(join(outDir, binName), 0o755);

log('拷贝前端 dist……');
cpSync(distDir, join(outDir, 'dist'), { recursive: true });

// ---------------------------------------------------------------------------
// 5. 生成与当前平台匹配的启动脚本
// ---------------------------------------------------------------------------
if (isWindows) {
  const startBat = [
    '@echo off',
    'chcp 65001 >nul',
    'cd /d "%~dp0"',
    'echo ============================================',
    'echo   Polaris Web 服务启动中...',
    'echo   浏览器访问: http://localhost:9830',
    'echo   自定义端口: start.bat --port 8080',
    'echo   关闭此窗口即可停止服务',
    'echo ============================================',
    'echo.',
    'polaris-web.exe %*',
    'pause',
    '',
  ].join('\r\n');
  writeFileSync(join(outDir, 'start.bat'), startBat, 'utf8');
} else {
  const startSh = [
    '#!/bin/bash',
    '# Polaris Web 服务启动脚本（默认 0.0.0.0:9830）',
    '# 自定义端口： ./start.sh --port 8080',
    'cd "$(dirname "$0")"',
    'echo "Polaris Web 启动中，浏览器访问 http://localhost:9830 （Ctrl+C 停止）"',
    './polaris-web "$@"',
    '',
  ].join('\n');
  writeFileSync(join(outDir, 'start.sh'), startSh, 'utf8');
  chmodSync(join(outDir, 'start.sh'), 0o755);
}

// ---------------------------------------------------------------------------
// 6. 完成提示
// ---------------------------------------------------------------------------
const sizeMB = (statSync(join(outDir, binName)).size / 1024 / 1024).toFixed(1);
console.log('');
ok('打包完成！');
console.log('');
console.log(`  输出目录: ${outDir}`);
console.log(`  二进制:   ${binName}  (${sizeMB} MB, ${process.platform}/${process.arch})`);
console.log('  前端:     dist/');
console.log('');
console.log('  启动方式：');
if (isWindows) {
  console.log('    双击  polaris-web\\start.bat');
  console.log('    或命令行: cd polaris-web && .\\polaris-web.exe');
  console.log('    自定义端口: .\\polaris-web.exe --port 8080');
} else {
  console.log('    cd polaris-web && ./start.sh');
  console.log('    自定义端口: ./polaris-web --port 8080');
}
console.log('');
console.log('  启动后浏览器访问: http://localhost:9830');
console.log('');
warn('注意：二进制是当前平台专用的，不能拷到其它系统运行。');
warn('      要在 Linux 上用，请把源码放到 Linux/WSL 上再次运行本脚本。');
