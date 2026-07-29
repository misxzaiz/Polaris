# Pocket 签名指南

> 本文档解决：为什么每次打包的 APK 签名不同，导致安装需要卸载旧版。
> 涵盖：根因、本地签名、CI 签名（GitHub Actions）、密钥安全。

---

## 1. 根因

Android 判断两个 APK 是否是同一个应用，依据是：

> **包名 + 签名证书 SHA-256 指纹 完全一致**

Pocket 的包名固定为 `com.polaris.pocket`。如果两次安装使用的**签名证书不同**，Android 会认为这是两个不同的应用，强制要求卸载旧的才能安装新的。

### 造成签名不一致的三个常见原因

| 原因 | 场景 | 后果 |
|------|------|------|
| **Unsigned APK 手动签名** | `tauri android build` 生成 unsigned APK，每次手动用不同 keystore 签名 | 证书指纹每次变化 |
| **Debug vs Release 签名** | Debug 用 `~/.android/debug.keystore`，Release 用自己的 keystore | 两种证书完全不相关 |
| **build.gradle 无 signingConfig** | release buildType 没有指定签名配置 | Gradle 产出的 APK 本身无签名 |

### 本项目的现状

- `tauri android build` 产出的 APK 是 **unsigned** 的（`app-universal-release-unsigned.apk`）
- `src-tauri/gen/android/app/build.gradle.kts` 的 release buildType 中**没有** `signingConfig`
- `tauri.conf.json` 的 `bundle.android` 段也**不支持** `signing` 字段

**所以每次都需要手动签名。** 只要手动签名时 keystore 和密码保持一致，证书指纹就一致，就可以直接升级安装。

---

## 2. 生成签名密钥（一次性操作）

在 `polaris-pocket/` 目录下运行：

```bash
keytool -genkeypair -v \
  -keystore polaris-pocket.keystore \
  -alias polaris-pocket \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass <你的密码> -keypass <你的密码> \
  -dname "CN=Polaris Pocket, OU=Pocket, O=Polaris, C=CN"
```

参数说明：

| 参数 | 值 | 说明 |
|------|-----|------|
| `-keystore` | `polaris-pocket.keystore` | keystore 文件名 |
| `-alias` | `polaris-pocket` | 密钥别名 |
| `-validity` | `10000` | 有效期 10000 天 |
| `-storepass` / `-keypass` | 自定义 | **记住密码，丢失后无法恢复** |

> ⚠️ keystore 和密码是**一对**，缺一不可。丢了密码就等于丢了 keystore，必须重新生成，之前的 APK 用户将无法升级。

---

## 3. 本地签名

`polaris-pocket/` 目录下运行：

```bash
# Step 1: 构建（含前端 + Rust + Gradle）
npm run build
npx tauri android build
# 产物: src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk

# Step 2: 对齐
/d/Android/Sdk/build-tools/35.0.0/zipalign -v -p 4 \
  src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk \
  app-universal-release-aligned.apk

# Step 3: 签名
java -jar /d/Android/Sdk/build-tools/35.0.0/lib/apksigner.jar sign \
  --ks polaris-pocket.keystore \
  --ks-pass pass:<你的密码> \
  --ks-key-alias polaris-pocket \
  --key-pass pass:<你的密码> \
  --out polaris-pocket-signed.apk \
  app-universal-release-aligned.apk

# Step 4: 验证
java -jar /d/Android/Sdk/build-tools/35.0.0/lib/apksigner.jar verify --print-certs polaris-pocket-signed.apk
# 输出示例:
# Signer #1 certificate SHA-256 digest: 7ccf3cd0d57634f618cce30899cb9af010888d84a435d67f59d6e9c260bf55ed
```

记录这个 `SHA-256 digest`，以后每次签名后对比，**一致说明是同一个证书**。

---

## 4. CI 签名（GitHub Actions）

参见仓库根目录的 `.github/workflows/android-release.yml`。

### 需要设置的 Repository Secrets

| Secret | 内容 | 说明 |
|--------|------|------|
| `POCKET_KEYSTORE_BASE64` | `base64 polaris-pocket.keystore` | keystore 文件的 base64 编码 |
| `POCKET_KEYSTORE_PASSWORD` | `<你的密码>` | keystore 密码 |
| `POCKET_KEY_ALIAS` | `polaris-pocket` | 密钥别名 |
| `POCKET_KEY_PASSWORD` | `<你的密码>` | 密钥密码 |

### 设置方法

```bash
# 将 keystore 转换为 base64（Linux/macOS）
base64 polaris-pocket.keystore | pbcopy

# 或 Windows
certutil -encode polaris-pocket.keystore tmp.b64 && cat tmp.b64
```

然后在 GitHub → 仓库 Settings → Secrets and variables → Actions → New repository secret 中添加。

### 使用方式

```bash
# 打 tag 后自动发布
git tag polaris-pocket-v1.1.1
git push origin polaris-pocket-v1.1.1

# 或者手动触发
# GitHub → Actions → Android Release → Run workflow
```

### 手动触发（不发 Release）

在 workflow 的 `workflow_dispatch` 触发器中填写版本号即可，不会创建 Release。

---

## 5. 安全要点

### 5.1 不要做

| ❌ 错误做法 | 为什么 |
|-------------|--------|
| 把 `polaris-pocket.keystore` 提交到 git | 任何人都能复制你的签名 |
| 把密码写死在 `build.gradle.kts` 中 | 密码随代码仓库公开 |
| 用 `~/.android/debug.keystore` 签 release | 任何机器上 debug keystore 的指纹都不同 |
| 在 CI 日志中打印密码 | GitHub Actions 日志公开可见 |

### 5.2 必须做

| ✅ 正确做法 | 说明 |
|-------------|------|
| `polaris-pocket/.gitignore` 排除 keystore | 已在 `.gitignore` 中（`*.jks`, `dist/*.apk`） |
| 密码通过 CI Secret 注入 | 工作流运行时才解密到临时目录 |
| 备份 keystore | 存在离线安全位置，丢失后无法恢复 |
| 记录证书指纹 | 每次发布后记录 SHA-256，用于验证一致性 |

### 5.3 `.gitignore` 现状

```
dist/*.apk       # 签名的 APK 不提交（可重建）
dist/*.jks       # keystore 不提交
*.apk.idsig      # 签名文件不提交
```

### 5.4 keystore 丢失的应急

1. 生成新 keystore（见 §2）
2. 用户需要**先卸载旧版**才能安装新版（证书指纹不同）
3. 下次发布前告知用户升级路径

---

## 6. 签名一致性检查清单

每次发布前确认：

- [ ] 使用的 keystore 文件和上次相同
- [ ] 使用的密码和上次相同
- [ ] `apksigner verify --print-certs` 输出的 SHA-256 指纹与上次一致
- [ ] CI workflow 使用的 Secrets 未过期/未修改
