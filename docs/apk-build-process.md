# APK 打包完整过程

> 适用范围：`polaris-mobile/` — Android APK 客户端
> 最后更新：2026-08-01

---

## 1. 背景

`polaris-mobile` 是 Polaris 的 Android 独立子项目：

- 与主仓共享同一份前端源码（`src/`），但**独立构建**前端产物至 `polaris-mobile/dist/`
- 使用 Tauri 2 的 Android 支持打包 APK
- 架构：**`MobileConnectionGate`（连接配置页）→ 完整 Web App（`App` 组件）**，与 Web 端一致的 UI

### 产品决策（2026-07-12，commit `d9abb31a`）

APK 不再使用旧 `MobileApp` 独立壳（底部 Tab 栏），改为复用完整 Web App：

```
浏览器 / 桌面端              → App（完整 Web UI）
APK（移动端 Tauri）          → MobileConnectionGate → App（连接配置 → 完整 Web UI）
?mobile=1（调试用）          → MobileApp（旧壳，仅供调试）
```

判定逻辑在 `src/main.tsx` 的 `RootApp()`：

| 场景 | 判定条件 | 渲染 |
|---|---|---|
| 调试旧壳 | `?mobile=1` | `MobileApp` |
| APK | `isMobileTauriRuntime()`（UA 含 Android + `__TAURI_INTERNALS__`） | `MobileConnectionGate + App` |
| Web | 其它 | `App` |

---

## 2. 目录结构

```
polaris-mobile/
├── package.json                  ← 最小 package.json（仅 @tauri-apps/cli 依赖）
├── dist/                         ← 前端构建产物（从主仓复制）
│   ├── assets/
│   │   ├── main-*.js             ← 主入口（含所有 React 组件）
│   │   ├── index-*.css           ← 样式
│   │   └── ...
│   └── index.html
└── src-tauri/
    ├── Cargo.toml                ← Rust 项目配置
    ├── tauri.conf.json           ← Tauri 配置
    ├── build.rs                  ← Tauri 构建脚本
    ├── src/
    │   ├── main.rs               ← Rust bin 入口
    │   └── lib.rs                ← Rust lib 入口（cdylib for Android JNI）
    ├── capabilities/
    │   └── default.json          ← 权限配置
    ├── icons/
    │   └── icon.png              ← 应用图标
    └── gen/android/              ← 由 `tauri android init` 生成
        ├── app/
        │   ├── build.gradle.kts   ← 模块构建脚本
        │   ├── proguard-rules.pro ← ProGuard 规则
        │   ├── proguard-wry.pro   ← wry ProGuard 规则
        │   ├── tauri-proguard.pro ← Tauri ProGuard 规则
        │   ├── src/main/
        │   │   ├── AndroidManifest.xml
        │   │   ├── java/com/polaris/mobile/
        │   │   │   └── MainActivity.kt
        │   │   ├── jniLibs/       ← .so libpolaris_mobile_lib.so（构建时生成）
        │   │   ├── assets/        ← 前端资产（构建时从 dist 复制）
        │   │   └── res/           ← Android 资源（图标、布局、主题）
        │   ├── tauri.build.gradle.kts
        │   └── tauri.properties
        ├── build.gradle.kts      ← 根 Gradle 配置
        ├── buildSrc/
        │   ├── build.gradle.kts
        │   └── src/main/java/.../
        │       ├── BuildTask.kt  ← Rust 构建任务
        │       └── RustPlugin.kt ← Rust Gradle 插件
        ├── gradle.properties
        ├── gradle/wrapper/
        │   ├── gradle-wrapper.jar
        │   └── gradle-wrapper.properties
        ├── gradlew / gradlew.bat
        ├── settings.gradle       ← 引用 tauri.settings.gradle（构建时生成）
        └── tauri.settings.gradle ← 引用 tauri-android 项目（构建时生成，本地路径）
```

**版本管理注意**：以下文件由 `tauri android init` 或 `tauri android build` 动态生成，**不应提交到 git**（已在 `.gitignore` 中忽略）：

- `gen/schemas/`（JSON Schema）
- `gen/android/tauri.settings.gradle`（含本地 cargo registry 路径）
- `gen/android/app/tauri.build.gradle.kts`
- `gen/android/app/src/main/jniLibs/`（.so 文件）
- `gen/android/app/src/main/assets/assets/` 和 `index.html`、`tauri.svg`、`vite.svg`（前端资产）
- `gen/android/build/` 和 `gen/android/app/build/`（构建输出）
- `gen/android/.gradle/`（Gradle 缓存）

---

## 3. 完整打包流程

> ⚠️ **重要：当前环境不推荐使用 `npx tauri android build` 一条命令打包**
> 该命令在 Windows 上可能无法正确将前端资产复制到 APK 中（见 5.7）。
> 请使用下方的**手动分步流程**（3.3），经过验证更可靠。

### 3.1 环境要求

| 组件 | 版本 | 验证命令 |
|---|---|---|
| JDK | 17+ | `java -version` |
| Android SDK | 34+（含 platform 34+、build-tools 34+） | `ls $ANDROID_SDK_ROOT/platforms/` |
| Android NDK | 26.1.10909125 | `ls $ANDROID_SDK_ROOT/ndk/` |
| Rust | stable | `rustc --version` |
| Rust Android targets | aarch64-linux-android 等 | `rustup target list --installed` |
| Tauri CLI | 2.11+ | `npx tauri --version` |
| cargo-ndk（可选） | 4.x | `cargo ndk --version` |

**环境变量**（必须设置）：

```bash
export ANDROID_HOME=D:/Android/Sdk
export ANDROID_SDK_ROOT=D:/Android/Sdk
# ANDROID_NDK_HOME 由 Tauri CLI 自动探测（基于 SDK 内的 NDK 目录）
```

**本机验证结果**：

| 组件 | 状态 |
|---|---|
| JDK 17 | ✅ C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot |
| Android SDK | ✅ D:\Android\Sdk（含 platforms 34/36、build-tools 34/35） |
| NDK 26.1.10909125 | ✅ D:\Android\Sdk\ndk\26.1.10909125 |
| Rust targets | ✅ aarch64/armv7/i686/x86_64-linux-android |
| Tauri CLI | ✅ 2.11.4（通过 npx） |
| cargo-ndk | ✅ 4.1.2（仅手动编译 .so 时需要） |
| Gradle wrapper | ✅ 8.14.3（项目内自带） |

### 3.2 一条命令打包（不推荐 — 可能遗漏前端资产）

`tauri android build` 会自动完成代码生成、Rust 编译、前端资产复制、Gradle 打包，但在当前 Windows 环境下**可能无法正确将前端资产复制到 APK**（见 5.7）：

```bash
# 1. 在主仓构建最新前端
cd /d/space/base/Polaris
pnpm run build

# 2. 同步前端产物到 polaris-mobile
rm -rf polaris-mobile/dist
cp -r dist polaris-mobile/dist

# 3. 一条命令打包 APK
cd polaris-mobile
npx tauri android build --apk -t aarch64 --split-per-abi
```

**参数说明**：
- `--apk`：只生成 APK（不生成 AAB）
- `-t aarch64`：仅编译 arm64 架构（最小体积，主流安卓设备）
- `--split-per-abi`：按 ABI 拆分 APK

**产物路径**：

```
polaris-mobile/src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release.apk
```

### 3.3 ✅ 推荐流程：手动分步打包（更可靠）

这是当前环境**更可靠的方式**——手动控制每一步，确保前端资产和 Rust 库都被正确打包：

```bash
cd /d/space/base/Polaris

# 0. 前置准备：构建前端 + 同步到 polaris-mobile/dist
pnpm run build
rm -rf polaris-mobile/dist
cp -r dist polaris-mobile/dist

# 1. 编译 Rust 原生库（用 cargo-ndk）
cd polaris-mobile/src-tauri
cargo ndk -t arm64-v8a -o gen/android/app/src/main/jniLibs build --release
# ⚠️ cargo ndk 复制 .so 可能失败（Windows 符号链接 / os error 448）
# 失败时手动复制：
#   rm -f gen/android/app/src/main/jniLibs/arm64-v8a/libpolaris_mobile_lib.so
#   cp target/aarch64-linux-android/release/libpolaris_mobile_lib.so \
#     gen/android/app/src/main/jniLibs/arm64-v8a/libpolaris_mobile_lib.so

# 2. 复制前端资产到 Android assets 目录
rm -rf gen/android/app/src/main/assets
cp -r ../dist gen/android/app/src/main/assets
# 确保 tauri.conf.json 也在 assets 中
cp tauri.conf.json gen/android/app/src/main/assets/tauri.conf.json

# 3. Gradle 打包（跳过 Rust 编译，因为已预编译 .so）
cd gen/android
./gradlew :app:assembleArm64Release -x :app:rustBuildArm64Release

# 4. 产物路径
#   polaris-mobile/src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release.apk
```

**注意**：`-x :app:rustBuildArm64Release` 跳过 Gradle 内部的 Rust 编译任务，
因为 BuildTask.kt 会尝试连接 Tauri WebSocket 服务（`npx tauri android android-studio-script`），
如果没有先启动 `tauri android build` 则会失败。

---

## 4. 关键配置详解

### 4.1 `tauri.conf.json`

```json
{
  "build": {
    "frontendDist": "../dist"    // 指向前端产物目录
  },
  "app": {
    "security": {
      "csp": null,
      "dangerousDisableAssetCspModification": true   // 允许内联脚本
    }
  },
  "bundle": {
    "android": {
      "minSdkVersion": 24    // Android 7.0+
    }
  }
}
```

### 4.2 `app/build.gradle.kts` 关键配置

```kotlin
android {
    defaultConfig {
        // 局域网 HTTP 连接需要明文流量
        manifestPlaceholders["usesCleartextTraffic"] = "true"
    }
    buildTypes {
        release {
            isMinifyEnabled = false    // ⚠️ 必须关闭 R8 minify
            // 开启 minify 会压掉 Tauri 反射调用的 Java 桥接类，
            // 启动报 "Failed to request http://tauri.localhost/"
            signingConfig = signingConfigs.getByName("debug")  // 用 debug 签名
        }
    }
}
```

### 4.3 `build.gradle.kts`（根）— 国内 Maven 镜像

```kotlin
allprojects {
    repositories {
        maven { setUrl("https://maven.aliyun.com/repository/google") }
        maven { setUrl("https://maven.aliyun.com/repository/public") }
        google()
        mavenCentral()
    }
}
```

### 4.4 `gradle-wrapper.properties` — 国内 Gradle 镜像

```properties
distributionUrl=https\://mirrors.cloud.tencent.com/gradle/gradle-8.14.3-bin.zip
```

### 4.5 `BuildTask.kt` — 预置 .so 跳过编译

`BuildTask.kt` 的 `assemble()` 方法开头检测 `jniLibs` 中是否已存在预编译的 `.so`，存在则跳过 Rust 编译（避免 Windows symlink 失败）：

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

**原因**：`polaris-mobile/dist/` 中的前端产物过旧，没有同步最新代码。

**修复**：
```bash
cd /d/space/base/Polaris
pnpm run build
rm -rf polaris-mobile/dist
cp -r dist polaris-mobile/dist
# 然后重新打包（见第 3 节）
```

**验证 APK 内置的前端版本**：
```bash
unzip -l polaris-mobile/src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release.apk \
  | grep "main-.*\.js"
```

### 5.2 `tauri android init` 失败：找不到 Cargo.toml

**原因**：`polaris-mobile/src-tauri/` 下缺失 `Cargo.toml` 或 `tauri.conf.json`。

**修复**：确保以下文件存在（模板见第 6 节）：
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
- `src-tauri/src/main.rs` 和 `src-tauri/src/lib.rs`
- `src-tauri/build.rs`
- `src-tauri/capabilities/default.json`

### 5.3 R8 minify 开启后 APK 启动崩溃

**症状**：`Failed to request http://tauri.localhost/`

**原因**：R8 混淆删除了 Tauri 反射调用的 Java 桥接类。

**修复**：`app/build.gradle.kts` 中设置 `isMinifyEnabled = false`。

### 5.4 Gradle 下载慢或超时

**修复**：
1. `gradle-wrapper.properties` 换腾讯云镜像（见 4.4）
2. `build.gradle.kts` 加阿里云 Maven 镜像（见 4.3）

### 5.5 `cargo ndk` 编译报错

**检查**：
1. `cargo install cargo-ndk`
2. `rustup target add aarch64-linux-android`
3. `Cargo.toml` 中 `tauri` feature 包含 `custom-protocol`
4. `ANDROID_NDK_HOME` 指向正确的 NDK 路径

### 5.6 `cargo ndk` 复制 .so 时失败：`os error 448`（不受信任的装入点）

**症状**：
```
Error: failed to copy ... over to ...
Caused by: 无法遍历该路径，因为它包含不受信任的装入点。 (os error 448)
```

**原因**：Windows 上 `cargo ndk` 的 copy 操作遇到了符号链接/挂载点问题。

**修复**：手动复制 .so 文件：
```bash
rm -f polaris-mobile/src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/libpolaris_mobile_lib.so
cp polaris-mobile/src-tauri/target/aarch64-linux-android/release/libpolaris_mobile_lib.so \
  polaris-mobile/src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/libpolaris_mobile_lib.so
```

### 5.7 ⚠️ 前端资产未打包进 APK（`npx tauri android build` 的已知问题）

**症状**：APK 体积偏小（~5.6MB 而非 19MB），APK 内缺少 `assets/index.html` 和 `assets/assets/main-*.js`。

**验证命令**：
```bash
unzip -l app-arm64-release.apk | grep -E "(index\.html|assets/main-)"
# 正常应有：assets/index.html 和 assets/assets/main-*.js
```

**原因**：`tauri android build` 在本机 Windows 环境下，前端资产复制步骤可能未被执行。
可能是 Gradle 缓存或 Tauri CLI 的 WebSocket 资产服务未能正确分发资产。

**修复**：
1. 清理 Gradle 缓存：`cd polaris-mobile/src-tauri/gen/android && ./gradlew clean`
2. 使用手动分步流程（见 3.3）
3. 验证 APK 内容：`unzip -l app-arm64-release.apk | grep "assets/"`

### 5.8 Kotlin 编译失败：`this and base files have different roots`

**症状**：
```
Caused by: java.lang.IllegalArgumentException: this and base files have different roots:
  C:\Users\<user>\.cargo\registry\src\...\tauri-2.11.5\mobile\android\...
  and D:\space\base\Polaris\polaris-mobile\src-tauri\gen\android.
```

**原因**：Kotlin daemon 的增量编译缓存试图在两个不同盘符（C: 和 D:）的文件之间计算相对路径，
导致 `toRelativeString` 失败。

**修复**：
- 该错误是 daemon 编译失败，Gradle 会自动 fallback 到**无 daemon 编译模式**，编译仍然成功。
- 如果想彻底消除，可以运行 `./gradlew --stop` 停止 Kotlin daemon，或设置 `kotlin.daemon.jvmargs` 避免跨盘符问题。
- 这不影响构建结果，只是多了一条警告。

### 5.9 Kotlin 编译报 `Unresolved reference: TauriActivity`

**原因**：`tauri-android` 项目未正确包含。

**修复**：`settings.gradle` 必须引用 `tauri.settings.gradle`（构建时自动生成，含本地 cargo registry 路径）：

```gradle
include ':app'
apply from: 'tauri.settings.gradle'
```

`tauri.settings.gradle` 内容（构建时生成）：

```gradle
include ':tauri-android'
project(':tauri-android').projectDir = new File("C:/Users/<user>/.cargo/registry/src/<hash>/tauri-2.11.5/mobile/android")
```

---

## 6. 项目文件模板

如果 `polaris-mobile/src-tauri/` 下的文件缺失，按以下模板创建：

### `src-tauri/Cargo.toml`

```toml
[package]
name = "polaris-mobile"
version = "1.0.0"
description = "Polaris Android WebView 客户端 — 复用完整 Web App"
authors = ["Polaris"]
edition = "2021"

[lib]
name = "polaris_mobile_lib"
crate-type = ["cdylib", "staticlib"]

[build-dependencies]
tauri-build = { version = "2.0", features = [] }

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tauri = { version = "2.0", features = ["custom-protocol"] }
```

### `src-tauri/tauri.conf.json`

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Polaris",
  "version": "1.0.0",
  "identifier": "com.polaris.mobile",
  "build": {
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "Polaris",
        "width": 412,
        "height": 915
      }
    ],
    "security": {
      "csp": null,
      "dangerousDisableAssetCspModification": true
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/icon.png"
    ],
    "android": {
      "minSdkVersion": 24
    }
  }
}
```

### `src-tauri/src/main.rs`

```rust
fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### `src-tauri/src/lib.rs`

```rust
// lib.rs — Tauri 要求的 lib 入口（Android 端需要 cdylib 供 JNI 加载）
// 所有逻辑在 main.rs 中，lib 仅用于 crate-type 定义
```

### `src-tauri/build.rs`

```rust
fn main() {
    tauri_build::build();
}
```

### `src-tauri/capabilities/default.json`

```json
{
  "identifier": "default",
  "description": "Capability for the main window",
  "webviews": ["main"],
  "permissions": [
    "core:default"
  ]
}
```

### `package.json`

```json
{
  "name": "polaris-mobile",
  "version": "1.0.0",
  "private": true,
  "devDependencies": {
    "@tauri-apps/cli": "^2"
  }
}
```

---

## 7. 快速参考

```bash
# === ✅ 推荐的完整打包流程（手动分步） ===

cd /d/space/base/Polaris

# 1. 构建前端
pnpm run build

# 2. 同步到 APK 项目
rm -rf polaris-mobile/dist
cp -r dist polaris-mobile/dist

# 3. 编译 Rust 原生库
cd polaris-mobile/src-tauri
cargo ndk -t arm64-v8a -o gen/android/app/src/main/jniLibs build --release
# 如果 cargo ndk 复制失败（os error 448），手动复制：
#   rm -f gen/android/app/src/main/jniLibs/arm64-v8a/libpolaris_mobile_lib.so
#   cp target/aarch64-linux-android/release/libpolaris_mobile_lib.so \
#     gen/android/app/src/main/jniLibs/arm64-v8a/libpolaris_mobile_lib.so

# 4. 复制前端资产到 Android assets 目录
rm -rf gen/android/app/src/main/assets
cp -r ../dist gen/android/app/src/main/assets
cp tauri.conf.json gen/android/app/src/main/assets/tauri.conf.json

# 5. Gradle 打包（跳过 Rust 编译）
cd gen/android
./gradlew :app:assembleArm64Release -x :app:rustBuildArm64Release

# 6. 产物路径
# D:/space/base/Polaris/polaris-mobile/src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release.apk
#
# 验证 APK 包含前端资产：
# unzip -l app-arm64-release.apk | grep -E "(index\.html|assets/main-)"
```

---

## 8. 签名说明

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
   buildTypes {
       release {
           signingConfig = signingConfigs.getByName("release")
       }
   }
   ```

3. 通过环境变量传入密码（避免硬编码）：
   ```bash
   export POLARIS_KEYSTORE_PASSWORD=xxx
   export POLARIS_KEY_PASSWORD=xxx
   npx tauri android build --apk -t aarch64 --split-per-abi
   ```

---

## 9. 相关文件

| 文件 | 作用 |
|---|---|
| `src/main.tsx` | React 根组件选择（`App` vs `MobileApp` vs `MobileConnectionGate`） |
| `src/mobile/platform.ts` | `isMobileTauriRuntime()`、`shouldRenderMobileApp()` 等判定函数 |
| `src/mobile/MobileConnectionGate.tsx` | APK 连接配置页（服务地址 + Token） |
| `src/mobile/MobileShell.tsx` | 旧 MobileApp 壳（仅调试用） |
| `.gitignore` | polaris-mobile 的精细化忽略规则（纳入版本管理） |