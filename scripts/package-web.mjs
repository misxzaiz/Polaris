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
  readdirSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const isWindows = process.platform === 'win32';
const binName = isWindows ? 'polaris-web.exe' : 'polaris-web';
const skipBuild = process.argv.slice(2).includes('--no-build');

// 内置 MCP server 二进制。与 polaris-web 同目录打包，匹配 run_web_server 将 resource_dir
// 设为可执行文件目录后的 fallback 解析布局（<exe_dir>/<bin>）。
// 全部为可选 —— 缺失时对应 MCP 工具不可用，但 AI 对话正常运行。
const mcpBins = [
  { name: 'polaris-todo-mcp', required: false },
  { name: 'polaris-requirements-mcp', required: false },
  { name: 'polaris-scheduler-mcp', required: false },
  { name: 'polaris-long-goal-mcp', required: false },
];
const mcpBinFile = (n) => (isWindows ? `${n}.exe` : n);

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
  // 逐个清空目录内容，而非删除目录本身：Windows 上若有进程的工作目录(cwd)
  // 停留在此目录，删除目录本身会因 EPERM/EBUSY 失败，但清空内容通常可成功。
  for (const entry of readdirSync(outDir)) {
    rmSync(join(outDir, entry), { recursive: true, force: true });
  }
} else {
  mkdirSync(outDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// 4. 拷贝二进制 + dist
// ---------------------------------------------------------------------------
log('拷贝二进制……');
copyFileSync(binSrc, join(outDir, binName));
if (!isWindows) chmodSync(join(outDir, binName), 0o755);

log('拷贝 MCP server 二进制……');
const releaseDir = join(root, 'src-tauri', 'target', 'release');
for (const { name, required } of mcpBins) {
  const file = mcpBinFile(name);
  const src = join(releaseDir, file);
  if (!existsSync(src)) {
    if (required) {
      fail(
        `缺少必需的 MCP 二进制：${src}\n` +
          '  请去掉 --no-build 重新运行；build:web 已包含全部 MCP server 的编译。',
      );
    }
    warn(`未找到可选 MCP 二进制 ${file}，跳过（对应功能在 Web 端将不可用）。`);
    continue;
  }
  const dest = join(outDir, file);
  copyFileSync(src, dest);
  if (!isWindows) chmodSync(dest, 0o755);
  ok(`已拷贝 MCP: ${file}`);
}

log('拷贝前端 dist……');
cpSync(distDir, join(outDir, 'dist'), { recursive: true });

// ---------------------------------------------------------------------------
// 5. 生成与当前平台匹配的启动 / 停止脚本
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
    'echo   停止服务: 关闭本窗口 / 按 Ctrl+C / 运行 stop.bat',
    'echo ============================================',
    'echo.',
    'polaris-web.exe %*',
    'pause',
    '',
  ].join('\r\n');
  writeFileSync(join(outDir, 'start.bat'), startBat, 'utf8');

  // 停止脚本：强制终止所有 polaris-web 进程（兜底，适用于后台运行或窗口已关闭的情况）
  const stopBat = [
    '@echo off',
    'chcp 65001 >nul',
    'echo 正在停止 Polaris Web 服务...',
    'taskkill /F /IM polaris-web.exe >nul 2>&1',
    'if %errorlevel%==0 (echo 服务已停止。) else (echo 当前没有正在运行的 Polaris Web 服务。)',
    'pause',
    '',
  ].join('\r\n');
  writeFileSync(join(outDir, 'stop.bat'), stopBat, 'utf8');
} else {
  const startSh = [
    '#!/bin/bash',
    '# Polaris Web 服务启动脚本（默认 0.0.0.0:9830）',
    '# 自定义端口： ./start.sh --port 8080',
    '# 停止服务：按 Ctrl+C，或在另一个终端运行 ./stop.sh',
    'cd "$(dirname "$0")"',
    'echo "Polaris Web 启动中，浏览器访问 http://localhost:9830 （Ctrl+C 停止）"',
    './polaris-web "$@"',
    '',
  ].join('\n');
  writeFileSync(join(outDir, 'start.sh'), startSh, 'utf8');
  chmodSync(join(outDir, 'start.sh'), 0o755);

  // 停止脚本：按进程名精确终止 polaris-web（兜底，适用于后台运行）
  const stopSh = [
    '#!/bin/bash',
    '# 停止 Polaris Web 服务',
    'echo "正在停止 Polaris Web 服务..."',
    'if pkill -x polaris-web; then',
    '  echo "服务已停止。"',
    'else',
    '  echo "当前没有正在运行的 Polaris Web 服务。"',
    'fi',
    '',
  ].join('\n');
  writeFileSync(join(outDir, 'stop.sh'), stopSh, 'utf8');
  chmodSync(join(outDir, 'stop.sh'), 0o755);
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
console.log('  停止方式：');
if (isWindows) {
  console.log('    关闭启动窗口 / 按 Ctrl+C / 双击 polaris-web\\stop.bat');
} else {
  console.log('    按 Ctrl+C / 运行 ./stop.sh');
}
console.log('');
console.log('  启动后浏览器访问: http://localhost:9830');
console.log('');
warn('注意：二进制是当前平台专用的，不能拷到其它系统运行。');
warn('      要在 Linux 上用，请把源码放到 Linux/WSL 上再次运行本脚本。');
