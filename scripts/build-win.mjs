#!/usr/bin/env node
/* eslint-disable no-console -- 构建脚手架脚本，过程日志走 stdout（AGENTS §六：协议数据流除外） */
/**
 * Windows 生产版 MSI 打包包装脚本（package.json `tauri:build:win` 的入口）。
 *
 * 背景：`tauri build` 没有原生的构建后钩子，MSI 产物复制到 release-local
 * 此前靠手工；按发版流程要求，打包成功后必须自动落一份到 release-local/。
 *
 * 流程：
 *   1. 透传执行 tauri build --config src-tauri/tauri.windows.conf.json --features multi-instance
 *      （失败时 exit code 原样透传，不执行复制）
 *   2. 版本号取自 src-tauri/tauri.conf.json（tauri 打包的单一权威来源）
 *   3. 复制 src-tauri/target/release/bundle/msi/polaris_<version>_x64_en-US.msi
 *      → <仓库根>/release-local/（同名覆盖）
 */
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// 1. 透传 tauri build
try {
  execSync(
    "pnpm exec tauri build --config src-tauri/tauri.windows.conf.json --features multi-instance",
    { cwd: repoRoot, stdio: "inherit" },
  );
} catch (err) {
  process.exit(err.status ?? 1);
}

// 2. 版本号单一权威：src-tauri/tauri.conf.json
const confPath = path.join(repoRoot, "src-tauri", "tauri.conf.json");
const version = JSON.parse(readFileSync(confPath, "utf8")).version;
if (!version) {
  console.error("[build-win] ❌ src-tauri/tauri.conf.json 缺少 version 字段，无法定位 MSI");
  process.exit(1);
}

// 3. 复制 MSI → release-local/
const msiName = `polaris_${version}_x64_en-US.msi`;
const msiSrc = path.join(repoRoot, "src-tauri", "target", "release", "bundle", "msi", msiName);
const releaseLocal = path.join(repoRoot, "release-local");
mkdirSync(releaseLocal, { recursive: true });
copyFileSync(msiSrc, path.join(releaseLocal, msiName));
console.log(`[build-win] ✅ 已复制: ${path.join(releaseLocal, msiName)}`);
