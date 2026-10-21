#!/usr/bin/env node
/**
 * 移动端 APK 打包前的前端构建脚本（Tauri beforeBuildCommand 调用）。
 *
 * 背景：polaris-mobile 复用仓库根的同一套前端源码（src/ + vite.config.ts），
 * 但 tauri android build 不会自动重建前端（桌面端靠 beforeBuildCommand: npm run build，
 * 移动端此前缺失）。若直接用手工维护的 polaris-mobile/dist 旧快照，APK 会打包过期前端。
 *
 * 做法：
 *   1. 切换到仓库根（vite.config.ts 的 index.html / alias 均相对仓库根解析，cwd 必须是仓库根）
 *   2. 执行 `pnpm build`（vite build → 仓库根 dist/，含最新源码）
 *   3. 清空 polaris-mobile/dist 后拷贝过去（避免多次构建的孤儿 chunk 叠加）
 *
 * 幂等：每次打包前必然重建，dist 始终与源码一致。
 */
import { execSync } from "node:child_process";
import { rmSync, cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const mobileDist = path.join(__dirname, "dist");

console.log(`[build-dist] 仓库根: ${repoRoot}`);
console.log(`[build-dist] 移动端 dist: ${mobileDist}`);

// 1. 在仓库根构建前端（最新源码）
console.log("[build-dist] 在仓库根执行 pnpm build ...");
execSync("pnpm build", {
  cwd: repoRoot,
  stdio: "inherit",
});

// 2. 清空移动端旧 dist（含历史孤儿 chunk），再同步最新产物
console.log("[build-dist] 同步 dist → polaris-mobile/dist ...");
rmSync(mobileDist, { recursive: true, force: true });
mkdirSync(mobileDist, { recursive: true });
cpSync(path.join(repoRoot, "dist"), mobileDist, { recursive: true });

console.log("[build-dist] 完成：移动端 dist 已更新为最新构建");
