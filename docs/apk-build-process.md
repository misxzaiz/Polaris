# APK 打包完整过程

> 适用范围：`polaris-mobile/` — Android APK 客户端
> 最后更新：2026-08-02

---

## 1. 背景

`polaris-mobile` 是 Polaris 的 Android 独立子项目：

- 与主仓共享同一份前端源码（`src/`），前端构建产物复制到 `polaris-mobile/dist/`
- 使用 Tauri 2 的 Android 支持打包 APK
- 架构：**`MobileConnectionGate`（连接配置页）→ 完整 Web App（`App` 组件）**，与 Web 端一致的 UI

### 产品决策（2026-07-12，commit `d9abb31a`）

APK 不再使用旧 `MobileApp` 独立壳（底部 Tab 栏），改为复用完整 Web App：

```
浏览器 / 桌面端              → App（完整 Web UI）
APK（移动端 Tauri）          → MobileConnectionGate → App（连接配置 → 完整 Web UI）
?mobile=1（调试用）          → MobileApp（旧壳，仅供调试）
```

---

## 2. 目录结构

```
polaris-mobile/
├── package.json                  ← 最小 package.json（仅 @tauri-apps/cli 依赖）
├── dist/                         ← 前端构建产物（从主仓复制，.gitignore）
├── src-tauri/
│   ├── Cargo.toml                ← Rust 项目配置
│   ├── tauri.conf.json           ← Tauri 配置（frontendDist: "../dist"）
│   ├── src/
│   │   ├── main.rs               ← Rust bin 入口
│   │   └── lib.rs                ← Rust lib 入口（cdylib for Android JNI）
│   ├── capabilities/default.json
│   ├── icons/icon.png
│   └── gen/android/              ← 由 `tauri android init` 生成
│       ├── app/build.gradle.kts
│       ├── build.gradle.kts
│       ├── buildSrc/             ← BuildTask.kt（预置 .so 跳过编译）
│       ├── gradlew / gradlew.bat
│       ├── settings.gradle
│       └── tauri.settings.gradle ← 构建时生成（.gitignore）
```

**`.gitignore` 中的关键忽略项**（构建时自动生成，无需手动管理）：

- `gen/android/app/src/main/jniLibs/`（.so 文件）
- `gen/android/app/src/main/assets/`（前端资产）
- `gen/android/build/`、`gen/android/app/build/`（构建输出）
- `gen/android/tauri.settings.gradle`（含本地 cargo registry 路径）
- `polaris-mobile/dist/`（前端产物副本）

---

## 3. 打包流程

### 3.1 环境要求

| 组件 | 最低版本 | 验证命令 |
|---|---|---|
| JDK | 17+ | `java -version` |
| Android SDK | 34+（含 platform 34+、build-tools 34+） | `ls $ANDROID_SDK_ROOT/platforms/` |
| Android NDK | 26.1.10909125 | `ls $ANDROID_SDK_ROOT/ndk/` |
| Rust | stable | `rustc --version` |
| Rust Android targets | aarch64-linux-android | `rustup target list --installed` |
| Tauri CLI | 2.11+ | `npx tauri --version` |

**环境变量**（必须设置）：

```bash
export ANDROID_HOME=D:/Android/Sdk
export ANDROID_SDK_ROOT=D:/Android/Sdk
```

### 3.2 ✅ 一条命令打包（推荐）

三步完成：

```bash
cd /d/space/base/Polaris

# 1. 构建前端
pnpm run build

# 2. 同步前端产物到 polaris-mobile
rm -rf polaris-mobile/dist
cp -r dist polaris-mobile/dist

# 3. 一条命令打包 APK（自动处理 Rust 编译 + 资产复制 + Gradle 打包）
cd polaris-mobile
npx tauri android build --apk -t aarch64 --split-per-abi
```

**参数说明**：
- `--apk`：只生成 APK（不生成 AAB）
- `-t aarch64`：仅编译 arm64 架构（主流安卓设备）
- `--split-per-abi`：按 ABI 拆分 APK

**产物路径**：

```
polaris-mobile/src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release.apk
```

**复制到项目根目录 temp 文件夹（方便下载）**：

```bash
mkdir -p temp
cp polaris-mobile/src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release.apk \
  temp/polaris-mobile.apk
```

### 3.3 首次构建说明

首次运行 `npx tauri android build` 时会：
1. 自动生成 `gen/android/` 目录（如果缺失）
2. 编译 Rust 为 `aarch64-linux-android` 目标（带 `mobile` cfg，正确生成 JNI 符号）
3. 创建 `.so` 符号链接到 `jniLibs/`（Gradle 能正确处理）
4. 从 `polaris-mobile/dist/` 复制前端资产到 `Android assets/`
5. 运行 Gradle 打包 APK

后续构建时，如果 Rust 代码未变更，编译会走缓存，大幅加快速度。

---

## 4. 关键配置

### 4.1 `tauri.conf.json`

```json
{
  "build": {
    "frontendDist": "../dist"    // 指向 polaris-mobile/dist/
  },
  "app": {
    "security": {
      "csp": null,
      "dangerousDisableAssetCspModification": true
    }
  },
  "bundle": {
    "android": {
      "minSdkVersion": 24
    }
  }
}
```

### 4.2 `app/build.gradle.kts` 关键配置

```kotlin
android {
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "true"  // 局域网 HTTP
    }
    buildTypes {
        release {
            isMinifyEnabled = false    // 关闭 R8 minify（防 Tauri 反射调用被压掉）
            signingConfig = signingConfigs.getByName("debug")  // debug 签名
        }
    }
}
```

### 4.3 `BuildTask.kt` — 预置 .so 跳过编译

当 `jniLibs/` 中已存在 `.so` 文件时，`BuildTask` 跳过 Rust 编译，避免 WebSocket 连接失败：

```kotlin
@TaskAction
fun assemble() {
    val jniLibsDir = File(project.projectDir, "src/main/jniLibs")
    val soFile = File(jniLibsDir, "$archDir/libpolaris_mobile_lib.so")
    if (soFile.exists() && soFile.isFile()) {
        logger.info("Pre-built .so found, skipping Rust build")
        return
    }
    // ... 否则调用 tauri-cli 编译
}
```

---

## 5. 常见问题

### 5.1 APK 样式与 Web 不一致 / 显示旧 MobileApp 壳

**原因**：`polaris-mobile/dist/` 中的前端产物过旧。

**修复**：
```bash
cd /d/space/base/Polaris
pnpm run build
rm -rf polaris-mobile/dist
cp -r dist polaris-mobile/dist
# 然后重新打包
```

**验证 APK 内置的前端版本**：
```bash
unzip -l polaris-mobile/src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release.apk \
  | grep "main-.*\.js"
```

### 5.2 R8 minify 开启后 APK 启动崩溃

**症状**：`Failed to request http://tauri.localhost/`

**原因**：R8 混淆删除了 Tauri 反射调用的 Java 桥接类。

**修复**：`app/build.gradle.kts` 中设置 `isMinifyEnabled = false`。

### 5.3 Gradle 下载慢或超时

**修复**：
- `gradle-wrapper.properties` 换腾讯云镜像：`https://mirrors.cloud.tencent.com/gradle/gradle-8.14.3-bin.zip`
- `build.gradle.kts` 加阿里云 Maven 镜像

### 5.4 Kotlin 编译报 `this and base files have different roots`

**原因**：Kotlin daemon 在跨盘符（C: 和 D:）文件之间计算相对路径失败。

**影响**：无实际影响，Gradle 自动 fallback 到无 daemon 编译模式，构建仍然成功。

### 5.5 APK 中前端功能不可用（如 Token 统计）

**原因**：`polaris-mobile` 的 Rust 后端是独立项目，**不会**自动包含主项目 `src-tauri/` 中的命令。APK 中所有需要 Tauri `invoke()` 的本地功能不可用。

**解决方案**：APK 通过 `MobileConnectionGate` 连接远程桌面端使用，所有功能依赖远程服务而非本地 Rust 命令。

---

## 6. 快速参考

```bash
# === 完整打包流程 ===

cd /d/space/base/Polaris

# 1. 构建前端
pnpm run build

# 2. 同步到 APK 项目
rm -rf polaris-mobile/dist
cp -r dist polaris-mobile/dist

# 3. 打包 APK
cd polaris-mobile
npx tauri android build --apk -t aarch64 --split-per-abi

# 4. 复制到 temp 目录方便下载
cd ..
mkdir -p temp
cp polaris-mobile/src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release.apk \
  temp/polaris-mobile.apk

# 5. 验证 APK 内容
unzip -l temp/polaris-mobile.apk | grep -E "(index\.html|assets/main-|\.so)"
```

---

## 7. 签名说明

当前 release 构建使用 `debug` 签名（方便内部测试）。**发布到应用商店前需要替换为正式签名**：

1. 生成密钥库：
   ```bash
   keytool -genkey -v -keystore polaris-release.keystore -alias polaris \
     -keyalg RSA -keysize 2048 -validity 10000
   ```

2. 在 `app/build.gradle.kts` 中配置：
   ```kotlin
   signingConfigs {
       create("release") {
           storeFile = file("../polaris-release.keystore")
           storePassword = System.getenv("POLARIS_KEYSTORE_PASSWORD")
           keyAlias = "polaris"
           keyPassword = System.getenv("POLARIS_KEY_PASSWORD")
       }
   }
   ```

3. 通过环境变量传入密码：
   ```bash
   export POLARIS_KEYSTORE_PASSWORD=xxx
   export POLARIS_KEY_PASSWORD=xxx
   npx tauri android build --apk -t aarch64 --split-per-abi
   ```

---

## 8. 相关文件

| 文件 | 作用 |
|---|---|
| `src/main.tsx` | React 根组件选择（`App` vs `MobileApp` vs `MobileConnectionGate`） |
| `src/mobile/platform.ts` | `isMobileTauriRuntime()`、`shouldRenderMobileApp()` 等判定函数 |
| `src/mobile/MobileConnectionGate.tsx` | APK 连接配置页（服务地址 + Token） |
| `src/mobile/MobileShell.tsx` | 旧 MobileApp 壳（仅调试用） |
| `.gitignore` | polaris-mobile 的精细化忽略规则 |