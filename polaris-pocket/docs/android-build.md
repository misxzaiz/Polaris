# Polar Pocket Android 打包文档

## 前置条件

- **Rust**: 已安装 `aarch64-linux-android` target（`rustup target add aarch64-linux-android`）
- **Android SDK**: ANDROID_HOME 指向 `D:\Android\Sdk`，包含 NDK 26.1+
- **JDK**: JDK 17+（`keytool` 签名用）
- **Node.js**: 18+，npm/pnpm

## 构建流程（4 步）

### Step 1: 构建前端

```bash
cd polaris-pocket
npm run build
# 产物: dist/index.html + dist/assets/*.js + dist/assets/*.css
```

### Step 2: 编译 Rust native library

```bash
cd polaris-pocket/src-tauri
cargo build --lib --target aarch64-linux-android --release
# 产物: target/aarch64-linux-android/release/libpolaris_pocket_lib.so
```

### Step 3: 注入文件到 Android 源码

```bash
# 复制前端资源
cp -r ../dist/index.html /d/.../gen/android/app/src/main/assets/
cp -r ../dist/assets /d/.../gen/android/app/src/main/assets/

# 复制 native library
cp target/aarch64-linux-android/release/libpolaris_pocket_lib.so /d/.../gen/android/app/src/main/jniLibs/arm64-v8a/
```

### Step 4: Gradle 打包 + 签名

```bash
cd /d/.../gen/android

# 只跳过 rustBuild 任务（因为 Rust 已在 Step 2 编译好）
./gradlew.bat clean :app:packageUniversalRelease \
  -x :app:rustBuildUniversalRelease \
  -x :app:rustBuildArm64Release \
  -x :app:rustBuildArmRelease \
  -x :app:rustBuildX86Release \
  -x :app:rustBuildX86_64Release

# 产物: build/outputs/apk/universal/release/app-universal-release-unsigned.apk

# 签名
java -jar /d/Android/Sdk/build-tools/35.0.0/lib/apksigner.jar sign \
  --ks pocket-release.jks --ks-pass pass:pocket123 \
  --ks-key-alias pocket --key-pass pass:pocket123 \
  --out ../dist/polaris-pocket-universal.apk \
  build/outputs/apk/universal/release/app-universal-release-unsigned.apk

# 产物: polaris-pocket-universal.apk
```

## 关键约束

1. **只能跳过 `rustBuild*` 任务**——不能跳过 `mergeJniLibFolders` / `mergeNativeLibs`，否则 .so 不会进 APK
2. **前端资源必须存在于 `src/main/assets/`**——没有 index.html 的 APK 会完全空白
3. **native .so 必须存在于 `src/main/jniLibs/arm64-v8a/`**——没有 .so 的 APK 安装时报「安装文件错误 -2」
4. **签名必须在注入所有文件之后**——先签名再追加文件会破坏签名块

## 产物结构

```
APK (11.6 MB)
├── assets/
│   ├── index.html              ← 前端入口
│   └── assets/
│       ├── main-*.js           ← React 应用
│       └── index-*.css         ← 样式
├── lib/
│   └── arm64-v8a/
│       └── libpolaris_pocket_lib.so  ← Tauri native runtime
├── classes.dex                 ← Kotlin/Java
├── resources.arsc              ← Android 资源
└── META-INF/                   ← 签名
```

## 常见问题

| 错误 | 原因 | 解决 |
|------|------|------|
| 安装失败 (-2) | 缺少 .so 或签名块损坏 | 确认 `mergeJniLibFolders` 未跳过 |
| 白屏 | 缺少 index.html | 确认前端 dist 已复制到 assets/ |
| 启动闪退 | Tauri WebView 初始化失败 | 确认 .so 架构匹配手机 CPU |

## 自签名 Key 生成

```bash
keytool -genkeypair -v -keystore pocket-release.jks \
  -alias pocket -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass pocket123 -keypass pocket123 \
  -dname "CN=Polaris Pocket, OU=Pocket, O=Polaris, L=Shenzhen, ST=Guangdong, C=CN"
```
