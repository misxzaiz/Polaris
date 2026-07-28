# App 端 ngrok 连接问题修复（完整记录）

> 时间：2026-07-28
> 涉及 commit：`5c659611`、`112254c8`、`bd449b46`
> 发布：[v10.2.3](https://github.com/misxzaiz/Polaris/releases/tag/v10.2.3)
> 状态：✅ 已验证成功

---

## 1. 问题现象

- **浏览器**直接访问 `https://*.ngrok-free.app` → ✅ 正常
- **App（Android WebView）** 填入同一地址 → ❌ 报 "Failed to fetch"

修复 ngrok 问题后又出现新问题：
- App 连接成功但**渲染了桌面端 CLI 检测界面**（"连接失败"、"当前路径: claude"、"问题诊断"），而非移动端连接配置页

---

## 2. 根因分析（两层）

### 2.1 第一层：ngrok 免费版的浏览器警告页

ngrok 免费版会对**首次访问的浏览器**弹出 "Visit Site" 警告中间页，并记录访问状态到**浏览器 cookie**。

| 客户端 | 状态 |
|--------|------|
| 浏览器 | 已点过一次，cookie 记住，后续跳过 → 正常 |
| App WebView | cookie 存储独立，从未点过 → 每次被中间页拦截 |

**App 的 WebView 请求根本到不了后端服务**，直接停在 ngrok 中间页，所以 fetch 报 "Failed to fetch"。

### 2.2 第一次修复方案为什么不行

尝试在 `httpTransport.ts` 加 `ngrok-skip-browser-warning` 请求头。这个方法本身是 ngrok 官方支持的，但有一个隐藏陷阱：

```
客户端发送自定义请求头
  → 浏览器自动触发 CORS preflight（OPTIONS 请求）
  → preflight 请求【不携带自定义头】
  → 被 ngrok 中间页拦截
  → fetch 失败，报 "Failed to fetch"
```

**核心问题**：自定义请求头会触发 CORS preflight，而 preflight 不带自定义头，照样被拦。

### 2.3 第二层：非标准 UA 破坏平台检测

改用 ngrok 官方的第二个绕过方法：**非标准 User-Agent**。但硬编码 `Polaris-App/1.0` 引入了新 bug：

```
Polaris-App/1.0 (硬编码)
  → 前端 isMobilePlatform() 正则 /Android|iPhone|iPad/i.test(ua) → false
  → 平台误判为桌面端
  → 渲染桌面端 ConnectingOverlay（CLI 检测界面）而非 MobileConnectionGate
  → 服务端健康检查不含本地 Claude CLI 信息 → 报"连接失败"
```

这就是"修复 ngrok 后出现新问题"的根因——**UA 修复绕过了中间页，但把移动端平台检测也一并破坏了**。

---

## 3. 最终修复方案

### 3.1 服务端 CORS 全开

`src-tauri/src/web/router.rs` — `build_cors_layer()` 在 release 构建下也返回 `Access-Control-Allow-Origin: Any`。

> 说明：这是必要的配套措施，确保跨域场景下浏览器不拦跨域请求。但对 ngrok 中间页问题本身**不是根因**。

### 3.2 Android WebView 设置非标准 User-Agent（关键修复）

`polaris-mobile/src-tauri/gen/android/app/src/main/java/com/polaris/mobile/MainActivity.kt`：

```kotlin
override fun onWebViewCreate(webView: WebView) {
    // 设置非标准 User-Agent，让 ngrok 免费版跳过"Visit Site"警告中间页。
    // ngrok 会检测 UA 是否为标准浏览器（以 Mozilla/ 开头），非标准 UA
    // 直接放行。所有从 WebView 发出的请求（包括 fetch 的 preflight OPTIONS）
    // 都会携带此 UA，不会被中间页拦截。
    //
    // ⚠️ 注意：UA 必须包含 "Android" 关键字，否则前端 isMobilePlatform()
    // 会误判为桌面端（走 ConnectingOverlay 而非 MobileConnectionGate）。
    webView.settings.userAgentString =
      webView.settings.userAgentString.replace("Mozilla/5.0", "Polaris-App/1.0")
    super.onWebViewCreate(webView)
}
```

**关键点**：用 `replace("Mozilla/5.0", "Polaris-App/1.0")` 而非硬编码，保留原始 UA 后缀（含 `Android`、设备型号等）：

```
原始: Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/...)
修复: Polaris-App/1.0 (Linux; Android 14; Pixel 7 Build/...)
```

这样同时满足两个条件：
- ✅ **不含 `Mozilla/5.0`** 开头 → ngrok 跳过中间页
- ✅ **含 `Android`** → 前端 `isMobilePlatform()` 检测通过，渲染 `MobileConnectionGate`

### 3.3 移除失效的自定义头方案

`src/services/transport/httpTransport.ts` — 删除了之前加的 `ngrok-skip-browser-warning` 请求头（已确认无效，且会在非 ngrok 场景下污染请求头）。

---

## 4. 修改文件清单

| 文件 | 变更 |
|------|------|
| `polaris-mobile/src-tauri/gen/android/app/src/main/java/com/polaris/mobile/MainActivity.kt` | 新增 `onWebViewCreate` 覆写，将 `Mozilla/5.0` 替换为 `Polaris-App/1.0` |
| `src/services/transport/httpTransport.ts` | 移除 `ngrok-skip-browser-warning` 自定义请求头 |
| `src-tauri/src/web/router.rs` | CORS release 模式全开（已在之前 commit 中） |

---

## 5. APK 打包与发布

### 构建流程

```bash
cd /d/space/base/Polaris

# 1. 构建前端
pnpm run build

# 2. 同步到移动端
rm -rf polaris-mobile/dist && cp -r dist polaris-mobile/dist

# 3. 打包 APK
cd polaris-mobile
npx tauri android build --apk -t aarch64 --split-per-abi
```

### 发布产物

| 项目 | 值 |
|------|-----|
| Release 标签 | `v10.2.3` |
| Release URL | https://github.com/misxzaiz/Polaris/releases/tag/v10.2.3 |
| APK 文件 | `app-arm64-release.apk` |
| 大小 | ~17 MB |
| 架构 | arm64-v8a |
| 签名 | debug（内部测试） |

### 验证清单

| 检查项 | 方法 | 结果 |
|--------|------|------|
| UA 字符串已打包 | `unzip -p app-arm64-release.apk classes.dex \| grep -aoc "Polaris-App/1.0"` | ✅ 1 |
| 前端已包含最新代码 | 对比 `main-*.js` 时间戳 | ✅ 最新 |
| 浏览器正常 | 直接访问 ngrok URL | ✅ |
| App 连接正常 | 填入 ngrok 地址 → 点"保存并连接" | ✅ 已验证成功 |

---

## 6. 经验教训

1. **ngrok 中间页是 cookie 级别的**，不是请求头级别。WebView 与浏览器 cookie 隔离，加 cookie 的方案不可行。
2. **自定义请求头 + CORS preflight 陷阱**：自定义头会触发 OPTIONS preflight，而 preflight 不带自定义头。这是第一次修复方案失败的根因，容易被忽略。
3. **非标准 UA 是最可靠方案**：标准头、不带 cookie 依赖、不影响后端 API 行为、所有请求（含 preflight）都携带。
4. **UA 修改必须保留平台关键字**：非标准 UA 不能硬编码，必须保留 `Android` 等关键字，否则前端 `isMobilePlatform()` 误判为桌面端，渲染错误的 UI。这是第二次修复方案失败的根因。
5. **`tauri.conf.json` 的 `user_agent` 字段无效**：Tauri 2 schema 不识别该字段（编译报错 "Additional properties are not allowed"），必须通过 Kotlin 代码层面设置。
6. **APK 内置前端版本滞后**：旧 APK（凌晨构建）与当天修改的前端代码不一致，验证时必须确认 APK 内 `main-*.js` 的时间戳和改动是否匹配。
7. **多层连锁 bug 的排查思路**：修复 A 问题引入 B 问题，必须逐层验证，不能假设"修了就对了"。每一层修复后都要重新走完整测试链路。

---

## 7. 相关文件

| 文件 | 说明 |
|------|------|
| `docs/apk-build-process.md` | APK 打包完整流程文档 |
| `docs/apk-build-flash-crash-fix.md` | 首次打包闪退问题修复记录 |
| `src/services/transport/httpTransport.ts` | HTTP 传输层，fetch 请求构建 |
| `src/services/transport/detector.ts` | 平台检测，`isMobilePlatform()` 判定逻辑 |
| `polaris-mobile/src-tauri/gen/android/app/src/main/java/com/polaris/mobile/MainActivity.kt` | 移动端 Activity 入口，WebView 初始化 |

---

## 8. 测试步骤

1. 下载 [v10.2.3 APK](https://github.com/misxzaiz/Polaris/releases/tag/v10.2.3)
2. 手机安装
3. App 连接页填入 `https://dominant-ant-formerly.ngrok-free.app`
4. 点"保存并连接"
5. 预期：进入移动端连接配置页 → 连接成功 → 完整 Web App
