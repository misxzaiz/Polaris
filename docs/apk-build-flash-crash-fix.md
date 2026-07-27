# APK 打包过程记录 — 闪退问题修复

> 时间：2026-07-27
> 问题：安装 APK 后打开即闪退
> 涉及 commit：`e2c614e4`（首次恢复）、`9af3df24`（文档）

---

## 背景

`polaris-mobile` 在 2026-07-27 恢复并首次成功打包（`e2c614e4`），但安装到手机后**打开即闪退**。以下是定位、修复和最终打包的完整过程记录。

---

## 闪退根因分析

### 根因 1：`.so` 缺少 JNI 导出符号（直接导致闪退）

**现象**：APK 安装成功，打开应用后立即崩溃。

**根因**：`lib.rs` 中的入口函数使用了 `#[cfg_attr(mobile, tauri::mobile_entry_point)]`，其中 `mobile` 是一个 cfg 特性标志。但 `cargo ndk`（或通过 `gradlew` 调用的 `BuildTask`）在编译时**不会自动设置 `mobile` cfg flag**，导致 `#[cfg_attr(mobile, ...)]` 条件不满足，`tauri::mobile_entry_point` 宏**从未展开**，`.so` 中没有生成任何 JNI 入口符号。

**验证**：用 `llvm-objdump` 检查 `.so` 的符号表：

```bash
llvm-objdump -t target/aarch64-linux-android/release/libpolaris_mobile_lib.so \
  | grep -E "JNI_OnLoad|Java_com"
```

错误版本输出：**无任何 JNI 符号**（0 个匹配）。

**实际加载流程**：

```
APK 启动
  → Rust.kt init { System.loadLibrary("polaris_mobile_lib") }  ← 成功加载 .so
  → Rust.create()  ← Java 调用 JNI 方法
  → .so 中没有 Java_com_polaris_mobile_Rust_create 符号
  → UnsatisfiedLinkError  ← 闪退
```

**修复**：改用 `npx tauri android build` 一条命令打包。Tauri CLI 内部调用 `cargo build` 时会正确设置 `--cfg mobile` 特性，确保 `#[cfg_attr(mobile, tauri::mobile_entry_point)]` 展开生成 JNI 入口符号。

**验证（修复后）**：

```bash
llvm-objdump -t target/.../libpolaris_mobile_lib.so | grep "Java_com"
```

输出：**22 个 JNI 符号**，包括 `Java_com_polaris_mobile_Rust_create`、`Java_com_polaris_mobile_Rust_onActivityCreate` 等全部关键入口。

---

### 根因 2：APK 中 `.so` 以符号链接形式存在，Gradle 打包时未复制

**现象**：即使 `.so` 有正确 JNI 符号，APK 内部 `lib/arm64-v8a/` 目录为空。

**根因**：Windows 上 `tauri android build` 在创建 `jniLibs` 中的 `.so` 时使用了**符号链接**（symlink）指向 `target/` 下的构建产物。但 Gradle 的 `mergeJniLibFolders` 任务在处理 Windows 符号链接时**不会复制目标文件**，导致 APK 中缺少原生库。

**验证**：

```bash
# jniLibs 目录中是符号链接
ls -la gen/android/app/src/main/jniLibs/arm64-v8a/
# libpolaris_mobile_lib.so -> ../target/.../libpolaris_mobile_lib.so (symlink)

# APK 中无 .so
unzip -l app-arm64-release.apk | grep "\.so"
# (无输出)
```

**修复**：两个途径，任选其一：

1. **推荐**：`npx tauri android build` 一条命令——Tauri CLI 在 Gradle 调用前会**复制**而非 symlink `.so`，确保 Gradle 能正确打包。
2. **备选**：手动将 `.so` 复制为实际文件：
   ```bash
   rm gen/android/app/src/main/jniLibs/arm64-v8a/libpolaris_mobile_lib.so
   cp target/.../libpolaris_mobile_lib.so \
      gen/android/app/src/main/jniLibs/arm64-v8a/
   ```

---

### 根因 3（已规避）：`BuildTask` 调用 `android-studio-script` 需要 WebSocket

**现象**：`gradlew :app:assembleArm64Release` 单独运行时，`rustBuildArm64Release` 任务失败，报 `ConnectionRefused`。

**根因**：`BuildTask.kt` 执行 `npx tauri android android-studio-script`，该命令通过 WebSocket 与正在运行的 `tauri dev` 进程通信，离线时无服务端可连接。

**修复**：`npx tauri android build` 不会经过 `BuildTask`——它在调用 Gradle 前已在 CLI 层完成了 Rust 编译和 `.so` 复制。Gradle 侧的 `BuildTask` 检测到 `.so` 已存在时会跳过编译，不再触发 `android-studio-script` 调用。

---

## 最终打包流程

```bash
cd /d/space/base/Polaris

# 1. 构建前端
pnpm run build

# 2. 同步到 polaris-mobile
rm -rf polaris-mobile/dist
cp -r dist polaris-mobile/dist

# 3. 一条命令打包（自动处理代码生成 + Rust 编译 + JNI 符号 + 资产复制 + Gradle 打包）
cd polaris-mobile
npx tauri android build --apk -t aarch64 --split-per-abi
```

**产物**：

```
polaris-mobile/src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release.apk
```

## 最终 APK 验证

| 检查项 | 期望 | 结果 |
|---|---|---|
| APK 大小 | ~19MB | ✅ 19MB |
| `.so` 存在 | `lib/arm64-v8a/libpolaris_mobile_lib.so` | ✅ 11.4MB |
| 前端存在 | `assets/index.html` + `assets/assets/main-*.js` | ✅ 3.4MB |
| JNI 符号 | 22 个 `Java_com_polaris_mobile_Rust_*` | ✅ 全部存在 |
| 打包架构 | arm64-v8a only | ✅ |
| 签名 | debug 签名（内部测试） | ✅ |

## 经验总结

1. **不要单独用 `cargo ndk` 编译 Android APK**：`cargo ndk` 不会设置 `mobile` cfg，导致 JNI 入口宏不展开。必须通过 `npx tauri android build` 打包。
2. **Windows 符号链接问题**：Windows 下 symlink 需要开发者模式权限，Gradle 打包时不会跟随 symlink。Tauri CLI 在完整流程中会主动复制文件。
3. **`BuildTask.kt` 的预置 `.so` 跳过逻辑**：当 `.so` 已存在且是实际文件（非 symlink）时，`BuildTask` 会直接跳过 Rust 编译，避免 WebSocket 连接问题。
4. **一条命令优于分步操作**：`npx tauri android build` 自动处理所有步骤（代码生成、编译、符号生成、资产复制、打包），是最佳实践。

---

*本文档补充 `docs/apk-build-process.md` 中未覆盖的闪退排查过程。*
