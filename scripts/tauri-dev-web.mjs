// @ts-check
/**
 * tauri:dev 增强版 —— 固定后端 Web 端口为 9829 + 数据根锚点链解析
 * ==========================================
 *
 * 与 `pnpm tauri:dev` 的唯一区别：启动前注入以下环境变量：
 *
 * 1. `POLARIS_WEB_PORT=9829`：内置后端 Web server 固定监听 9829（默认会读
 *    config.web.port，可能是 9820/9830 或端口被占后动态顺延）。
 *
 * 2. `POLARIS_DEV_WEB_TOKEN=98279829++`：dev 桌面端 Web server 在 debug 构建下用
 *    此 token 覆盖 config.web.token（仅内存、不落盘）。已安装版（release 构建）
 *    不读此 env，继续用 config.json 里的真实 token —— 互不影响。
 *
 * 3. `POLARIS_DATA_ROOT` + `POLARIS_ANCHOR_DIR`：dev 数据根**锚点链**解析：
 *      a. 若外部已手工导出 `POLARIS_DATA_ROOT` → 透传不覆盖（但会告警：
 *         未同时提供 `POLARIS_ANCHOR_DIR` 时 UI 切换数据根会被后端守卫拒绝）；
 *      b. 否则读 dev 专属锚点 `%APPDATA%/Polaris-dev/anchor.json`：
 *         有 `dataRoot` 用之（dev 里改路径重启后即生效），无则回退
 *         `%APPDATA%/Polaris-dev`；
 *      c. 同时注入 `POLARIS_ANCHOR_DIR=<dev 锚点目录>`，保证「写的锚点 =
 *         下次启动读的锚点」（plans/data-root-dev-anchor-spec.md 不变式）。
 *
 * `--installed-anchor`（pnpm tauri:prod:web）：**不注入**数据根/锚点相关 env，
 * 后端解析自然落到安装版锚点链（%APPDATA%/Polaris/anchor.json）——
 * dev 构建以安装版的数据链运行；注意此模式下 UI 改数据根会改安装版锚点。
 *
 * 干跑：`--print-root` 只打印两种模式的解析结果与注入表，不启动任何进程。
 *
 * 停止：与 tauri:dev 相同，Ctrl+C 即可。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const installedAnchor = args.includes('--installed-anchor');
const printOnly = args.includes('--print-root');

// 解析 OS config_dir（Windows %APPDATA%；其他平台 XDG_CONFIG_HOME 或 ~/.config），
// 与 Rust 端 dirs::config_dir() 语义对齐。
function resolveConfigBase() {
  const base = process.env.APPDATA
    ?? process.env.XDG_CONFIG_HOME
    ?? (() => {
      const home = homedir();
      return home ? join(home, '.config') : null;
    })();
  return base || null;
}

/** 读锚点 JSON，损坏/缺失返回 null（与后端 read_anchor 容错语义一致） */
function readAnchorFile(anchorPath) {
  if (!existsSync(anchorPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(anchorPath, 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch (e) {
    console.warn(`[tauri-dev-web] 锚点解析失败，忽略: ${anchorPath} (${e.message})`);
    return null;
  }
}

/**
 * dev 锚点链解析：dev 锚点 dataRoot（须绝对路径）> dev 默认目录
 * @returns {{ root: string, anchorDir: string, from: 'dev-anchor' | 'dev-default' }}
 */
function resolveDevChain() {
  const base = resolveConfigBase();
  if (!base) throw new Error('无法解析 OS 配置目录（APPDATA / XDG_CONFIG_HOME / ~/.config）');
  const anchorDir = join(base, 'Polaris-dev');
  const anchor = readAnchorFile(join(anchorDir, 'anchor.json'));
  const custom = anchor && typeof anchor.dataRoot === 'string' ? anchor.dataRoot.trim() : '';
  if (custom) {
    // 锚点里存相对路径会让后端以 cwd 为基解析，行为不可预期，宁可不采纳
    const isAbsolute = /^[a-zA-Z]:[\\/]/.test(custom) || custom.startsWith('\\\\') || custom.startsWith('/');
    if (isAbsolute) {
      return { root: custom, anchorDir, from: 'dev-anchor' };
    }
    console.warn(`[tauri-dev-web] dev 锚点 dataRoot 非绝对路径，忽略: "${custom}"`);
  }
  return { root: anchorDir, anchorDir, from: 'dev-default' };
}

/** 安装版锚点链解析（--installed-anchor 干跑展示用；运行时由后端 Rust 解析） */
function resolveInstalledChain() {
  const base = resolveConfigBase();
  if (!base) throw new Error('无法解析 OS 配置目录（APPDATA / XDG_CONFIG_HOME / ~/.config）');
  const anchorDir = join(base, 'Polaris');
  const anchor = readAnchorFile(join(anchorDir, 'anchor.json'));
  const custom = anchor && typeof anchor.dataRoot === 'string' ? anchor.dataRoot.trim() : '';
  if (custom) return { root: custom, anchorDir, from: 'installed-anchor' };
  return { root: join(anchorDir), anchorDir, from: 'installed-default' };
}

function buildEnv() {
  // 两种模式共用的 dev Web 通道变量（与数据根无关）
  const env = {
    ...process.env,
    POLARIS_WEB_PORT: '9829',
    POLARIS_DEV_WEB_TOKEN: '98279829++',
  };

  if (installedAnchor) {
    // 安装版锚点模式：不注入任何数据根/锚点 env，后端走安装版锚点链
    return env;
  }

  // dev 隔离模式：锚点链解析 + 双 env 同注
  const external = (process.env.POLARIS_DATA_ROOT ?? '').trim();
  if (external) {
    console.warn(
      '[tauri-dev-web] 检测到外部 POLARIS_DATA_ROOT，透传不覆盖；' +
        '若未同时提供 POLARIS_ANCHOR_DIR，UI 切换数据根会被后端守卫拒绝。',
    );
    return env;
  }
  const dev = resolveDevChain();
  env.POLARIS_DATA_ROOT = dev.root;
  env.POLARIS_ANCHOR_DIR = dev.anchorDir;
  return env;
}

if (printOnly) {
  const dev = resolveDevChain();
  const installed = resolveInstalledChain();
  console.log('== pnpm tauri:dev:web（dev 隔离模式，锚点链）==');
  console.log(`  解析来源    : ${dev.from}`);
  console.log(`  数据根      : ${dev.root}`);
  console.log(`  锚点目录    : ${dev.anchorDir}`);
  console.log(`  注入 env    : POLARIS_DATA_ROOT=${dev.root}`);
  console.log(`                POLARIS_ANCHOR_DIR=${dev.anchorDir}`);
  console.log('== pnpm tauri:prod:web（--installed-anchor，安装版锚点模式）==');
  console.log(`  解析来源    : ${installed.from}`);
  console.log(`  数据根      : ${installed.root}`);
  console.log(`  锚点目录    : ${installed.anchorDir}`);
  console.log('  注入 env    : （无数据根相关 env，由后端读安装版锚点）');
  process.exit(0);
}

const childEnv = buildEnv();

const child = spawn('pnpm', ['run', 'tauri:dev'], {
  cwd: root,
  stdio: 'inherit',
  shell: true, // Windows 下解析 pnpm
  env: childEnv,
});

const forwardSignal = (signal) => {
  if (!child.killed) child.kill(signal);
};

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
