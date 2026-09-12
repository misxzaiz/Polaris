/* eslint-disable no-console */
// @ts-check
/**
 * tauri:dev 增强版 —— 固定后端 Web 端口为 9829
 * ==========================================
 *
 * 与 `pnpm tauri:dev` 的唯一区别：启动前注入 `POLARIS_WEB_PORT=9829` 环境变量，
 * 使内置后端 Web server 固定监听 9829（默认会读 config.web.port，可能是 9820/9830
 * 或端口被占后动态顺延）。
 *
 * 同时注入 `POLARIS_DEV_WEB_TOKEN=98279829++`：dev 桌面端 Web server 在 debug
 * 构建下用此 token 覆盖 config.web.token（仅内存、不落盘），浏览器访问 9827 时
 * 登录 token 固定为 `98279829++`。已安装版（release 构建）不读此 env，继续用
 * config.json 里的真实 token —— 互不影响。
 *
 * 作用：
 *   - 桌面开发（tauri:dev）时，浏览器可通过 http://<IP>:9829/api/* 直接访问后端
 *   - 前端 vite dev server 仍在 9827（vite.config.ts），互不冲突
 *
 * 停止：与 tauri:dev 相同，Ctrl+C 即可。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const child = spawn('pnpm', ['run', 'tauri:dev'], {
  cwd: root,
  stdio: 'inherit',
  shell: true, // Windows 下解析 pnpm
  env: {
    ...process.env,
    POLARIS_WEB_PORT: '9829',
    POLARIS_DEV_WEB_TOKEN: '98279829++',
  },
});

const forwardSignal = (signal) => {
  if (!child.killed) child.kill(signal);
};

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
