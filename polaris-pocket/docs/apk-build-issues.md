# Polaris Pocket APK 打包问题记录

## 问题一：APK 安装失败（错误 -2）

### 现象

手机上安装 APK 时弹出「安装文件错误 -2」，无法安装。

### 根因：缺少 Native Library

APK 中缺少 `lib/arm64-v8a/libpolaris_pocket_lib.so`。Android 的 `PackageManager` 解析时检测到应用声明了 native library（通过 `classes.dex` 中的 Tauri 代码），但 APK 里没有对应的 .so 文件，因此拒绝安装。

| 对比 | 损坏 APK | 正常 APK |
|------|---------|---------|
| 大小 | 5.3 MB | **11.6 MB** |
| 含 .so | ❌ | ✅ (9.1 MB) |
| 含前端 | ❌ | ✅ |
| 安装结果 | 报错 -2 | ✅ 正常 |

### 技术原因

Gradle 的 `RustPlugin` 中，`mergeJniLibFolders` 任务依赖 `rustBuild*` 任务：

```kotlin
// RustPlugin.kt 中
tasks["mergeArm64ReleaseJniLibFolders"].dependsOn(rustBuildArm64Release)
```

`rustBuild*` 在 Windows 上运行 `npm run -- tauri android android-studio-script` 失败（npm.bat 路径问题），导致整个任务链中断。

**错误做法：** 跳过 `mergeJniLibFolders` → .so 不会被复制到中间目录 → APK 缺失 library

**正确做法：** 只跳过 `rustBuild*` 任务，保持 `mergeJniLibFolders` 正常执行：

```bash
./gradlew.bat :app:packageUniversalRelease \
  -x :app:rustBuildUniversalRelease \
  -x :app:rustBuildArm64Release \
  -x :app:rustBuildArmRelease \
  -x :app:rustBuildX86Release \
  -x :app:rustBuildX86_64Release
```

### 前提条件

- `src/main/assets/` 中必须有前端资源（index.html + JS + CSS）
- `src/main/jniLibs/arm64-v8a/` 中必须有编译好的 .so

---

## 问题二：签名块损坏

### 现象

`apksigner verify` 提示通过，但 Android 实际安装时拒绝。

### 根因：签名后修改 APK

用 `zipfile.ZipFile(apk, 'a')` 追加 .so 文件到已签名的 APK 中，会破坏 APK 签名块（APK Signing Block）的结构。`zipfile.append` 重写了 ZIP 中央目录，但签名块中的哈希校验与新的文件内容不匹配。

### 技术细节

APK 签名块位于 ZIP 文件头和 ZIP 中央目录之间：

```
[ZIP entries][padding][APK Signing Block][ZIP Central Directory][EOCD]
```

`zipfile` 追加文件时，会重写 ZIP 中央目录到文件末尾，但 APK Signing Block 的位置是基于签名时的 ZIP 结构计算的。追加文件后，ZIP 中央目录的偏移发生变化，但签名块中的哈希无法更新。

### 修复

**先注入文件，再签名。** 顺序不能反：

1. 准备所有文件（前端资源 + .so）
2. 用 Gradle 打包 unsigned APK
3. 用 `apksigner` 签名（只签一次）

---

## 问题三：前端资源缺失

### 现象

APK 安装成功，打开后白屏。

### 根因

Tauri 的 Android 构建流程中，前端 `dist/` 由 `npm run build` 生成，但 `rustBuild*` 任务失败后，`mergeAssets` 步骤不会触发，导致 APK 中缺少 `assets/index.html` 和 JS/CSS。

### 修复

手动将前端资源复制到 Android 源码目录：

```bash
cp -r dist/index.html src-tauri/gen/android/app/src/main/assets/
cp -r dist/assets src-tauri/gen/android/app/src/main/assets/assets/
```

---

## 问题四：GitHub Release 上传错误版本

### 现象

上传了不正确的 APK 到 Draft Release，下载后安装失败。

### 根因

`dist/` 目录中同时存在多个版本的 APK 文件，上传时选错了路径。`gh release create` 上传后，旧的 Release 没有及时清理，用户下载到的是旧版的 5.3 MB APK。

### 修复

每次更新 Release 时：

1. 先 `gh release delete <tag> --yes`
2. 确认本地 APK 大小正确（11.6 MB）
3. 再 `gh release create <tag> ... <path/to/correct.apk>`
4. 验证 GitHub 上显示的 `size` 字段

---

## 问题五：.so 文件类型错误

### 排查过程（最终未确认）

分析发现 `libpolaris_pocket_lib.so` 的 `ELF e_type` 为 **3 (ET_EXEC)** 而非预期的 **2 (ET_DYN)**。但 polaris-mobile 的 .so 同样是 ET_EXEC=3，且能正常安装。因此这不是安装失败的原因。

### 结论

`cargo build --lib --target aarch64-linux-android --release` 生成的 .so 文件虽然 `e_type=3`，但在 Android 上可以正常加载。关键在于文件必须正确打包进 APK 的 `lib/arm64-v8a/` 目录，且签名块未被破坏。

---

## 总结检查清单

```
[ ] 前端 dist/index.html 已生成
[ ] 前端文件已复制到 assets/（含正确路径结构）
[ ] .so 已编译（cargo build --lib --target aarch64-linux-android --release）
[ ] .so 已复制到 jniLibs/arm64-v8a/
[ ] Gradle 打包时只跳过 rustBuild* 任务
[ ] 签名在注入所有文件之后执行
[ ] APK 大小 > 11 MB（含 .so 的基本大小）
[ ] GitHub Release 显示的 size 字段正确
```