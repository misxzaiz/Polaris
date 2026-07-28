# App 端 ngrok 连接 Failed to fetch 问题修复

> 时间：2026-07-28
> 涉及 commit：`5c659611`、`112254c8`
> 发布：[v10.2.3](https://github.com/misxzaiz/Polaris/releases/tag/v10.2.3)

---

## 1. 问题现象

- **浏览器**直接访问 `https://*.ngrok-free.app` → ✅ 正常
- **App（Android WebView）** 填入同一地址 → ❌ 报 "Failed to fetch"

---

## 2. 根因分析

### 2.1 ngrok 免费版的浏览器警告页

ngrok 免费版会对**首次访问的浏览器**弹出一个中间页，要求手动点击"Visit Site"才能继续，并记录访问状态到**浏览器 cookie**。

| 客户端 | 状态 |
|--------|------|
| 浏览器 | 已点过一次，cookie 记住，后续跳过 → 正常 |
| App WebView | cookie 存储独立，从未点过 → 每次被中间页拦截 |

**App 的 WebView 请求根本到不了后端服务**，直接停在 ngrok 中间页，所以 fetch 报 "Failed to fetch"。

### 2.2 为什么第一次修复方案不行

最初尝试在 `httpTransport.ts` 加 `ngrok-skip-browser-warning` 请求头。这个方法本身是正确的（ngrok 官方支持），但有一个隐藏陷阱：

```
客户端发送自定义请求头
  → 浏览器自动触发 CORS preflight（OPTIONS 请求）
  → preflight 请求【不携带自定义头】
  → 被 ngrok 中间页拦截
  → fetch 失败，报 "Failed to fetch"
```

**核心问题**：自定义请求头会触发 CORS preflight，而 preflight 不带自定义头，照样被拦。

### 2.3 正确方案

ngrok 官方提供的第二个绕过方法：**设置非标准浏览器 User-Agent**。

- User-Agent 是**标准头**，不会触发 CORS preflight
- **所有请求**（GET / POST / PATCH / DELETE / OPTIONS preflight）都携带
- ngrok 检测 UA 不以 `Mozilla/` 开头时，直接放行，跳过中间页

---

## 3. 修复方案

### 3.1 服务端 CORS 全开（之前已存在）

`src-tauri/src/web/router.rs` — `build_cors_layer()` 在 release 构建下也返回 `Access-Control-Allow-Origin: Any`。

> 说明：这是必要的配套措施，确保跨域场景下浏览器不拦跨域请求。但对 ngrok 中间页问题本身**不是根因**。

### 3.2 Android WebView 设置非标准 User-Agent（本次修复）

`polaris-mobile/src-tauri/gen/android/app/src/main/java/com/polaris/mobile/MainActivity.kt`：

```kotlin
class MainActivity : TauriActivity() {
    // ... onCreate() 不变 ...

    override fun onWebViewCreate(webView: WebView) {
        webView.settings.userAgentString = "Polaris-App/1.0"
        super.onWebViewCreate(webView)
    }
}
```

### 3.3 移除失效的自定义头方案

`src/services/transport/httpTransport.ts` — 删除了之前加的 `ngrok-skip-browser-warning` 请求头（已确认无效，且会在非 ngrok 场景下污染请求头）。

---

## 4. 修改文件清单

| 文件 | 变更 |
|------|------|
| `polaris-mobile/src-tauri/gen/android/app/src/main/java/com/polaris/mobile/MainActivity.kt` | 新增 `onWebViewCreate` 覆写，设置 `userAgentString = "Polaris-App/1.0"` |
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
| UA 字符串已打包 | `unzip -p app-arm64-release.apk classes.dex | grep -aoc "Polaris-App/1.0"` | ✅ 1 |
| 前端已包含最新代码 | 对比 `main-*.js` 时间戳 | ✅ 最新 |
| 浏览器正常 | 直接访问 ngrok URL | ✅ |
| App 连接正常 | 填入 ngrok 地址 → 点"保存并连接" | 待用户验证 |

---

## 6. 经验教训

1. **ngrok 中间页是 cookie 级别的**，不是请求头级别。WebView 与浏览器 cookie 隔离，加 cookie 的方案不可行。
2. **自定义请求头 + CORS preflight 陷阱**：自定义头会触发 OPTIONS preflight，而 preflight 不带自定义头。这是第一次修复方案失败的根因，容易被忽略。
3. **非标准 UA 是最可靠方案**：标准头、不带 cookie 依赖、不影响后端 API 行为、所有请求（含 preflight）都携带。
4. **`tauri.conf.json` 的 `user_agent` 字段无效**：Tauri 2 schema 不识别该字段（编译报错 "Additional properties are not allowed"），必须通过 Kotlin 代码层面设置。
5. **APK 内置前端版本滞后**：旧 APK（凌晨构建）与当天修改的前端代码不一致，验证时必须确认 APK 内 `main-*.js` 的时间戳和改动是否匹配。

---

## 7. 相关文件

| 文件 | 说明 |
|------|------|
| `docs/apk-build-process.md` | APK 打包完整流程文档 |
| `docs/apk-build-flash-crash-fix.md` | 首次打包闪退问题修复记录 |
| `src/services/transport/httpTransport.ts` | HTTP 传输层，fetch 请求构建 |
| `polaris-mobile/src-tauri/gen/android/app/src/main/java/com/polaris/mobile/MainActivity.kt` | 移动端 Activity 入口，WebView 初始化 |

---

## 8. 测试步骤

1. 下载 [v10.2.3 APK](https://github.com/misxzaiz/Polaris/releases/tag/v10.2.3)
2. 手机安装
3. App 连接页填入 `https://dominant-ant-formerly.ngrok-free.app`
4. 点"保存并连接"
5. 预期：进入完整 Web App，不再报 "Failed to fetch"
