# Bug: Web 模式 Token 鉴权通过后未自动触发生命周期初始化

## 问题描述

Web 模式（`currentMode === 'http'`）下，如果服务端配置了 token 鉴权，用户在 `ConnectingOverlay` 中输入正确 token 并提交后，页面停留在连接蒙板（spinner 或错误图标），**没有自动触发后续的初始化流程**（工作区同步、引擎引导、会话创建等）。目前用户的感知表现为「一直在转圈 / 显示错误图标，必须手动刷新页面才恢复正常」。

## 定位文件

| 文件 | 职责 |
|---|---|
| `src/stores/configStore.ts` | 状态管理：submitToken、loadConfig |
| `src/hooks/useAppInit.ts` | 应用初始化流程编排 |
| `src/components/Common/ConnectingOverlay.tsx` | Token 输入 UI |
| `src/services/transport/httpTransport.ts` | HTTP + WS 传输层，含 token 注入 |
| `src/services/transport/index.ts` | transport 单例入口 |
| `src/services/transport/auth.ts` | Token MD5 存取 |

## 流程分析

### 预期链路

```
首次加载
  → useAppInit#useEffect[0] → loadConfig()
    → 401 → connectionState = 'needsToken' → 显示 Token 输入
  → 用户输入 token → submitToken(token)
    → 存 MD5 到 localStorage → 调 getConfig + healthCheck
    → 成功 → connectionState = 'success'
  → useAppInit#useEffect[1] 监听到 connectionState === 'success'
    → 执行 runPostAuthInit()
      → 工作区同步、引擎引导、会话创建、集成初始化...
```

### 实际断点：可能失败在多个环节

---

#### 断点 1：`submitToken` 缺少 `loadConfig` 成功路径中的关键同步

对比 `loadConfig` 成功时（`configStore.ts:82-106`）和 `submitToken` 成功时（`configStore.ts:332`）：

| 步骤 | loadConfig | submitToken |
|---|---|---|
| 同步 modelProfiles → modelProfileStore | ✅ (L86-93) | ❌ 缺失 |
| 同步 activeModelProfileId → sessionConfigStore | ✅ (L98-106) | ❌ 缺失 |
| 异步获取 CLI 信息 (cliInfoStore.fetchAll) | ✅ (L109-112) | ❌ 缺失 |

虽然 `runPostAuthInit` 会处理大部分初始化，但 `modelProfileStore` 和 `sessionConfigStore` 的同步缺了，可能导致引擎引导时 Profile 未就绪。

---

#### 断点 2：WebSocket transport 状态异常

transport 是模块级单例（`transport/index.ts:88-90`）。token 提交后 **WebSocket 连接没有被显式重建或重置**：

- `httpTransport.ts:193-200`：WebSocket URL 通过 `getTokenMd5()` 从 localStorage 动态获取
- 但 `submitToken` 内部**没有调用 `manualReconnect()` 或 `disconnect()` + 重建**
- 如果首次加载时发生了 WebSocket 连接尝试（如 `initEventListeners` 触发 `listen()`），此时可能已经带空 token 连接并断开了
- 后续 `runPostAuthInit` 中的 `listen()` → `connectWs()`，如果 `wsConnecting` 有残留的 rejected promise，会静默失败

---

#### 断点 3：`useAppInit` 的第二个 useEffect 依赖 `isInitialized` flag

```
src/hooks/useAppInit.ts:292-299
```

这个 useEffect 虽然监听了 `connectionState`，但条件是 `!isInitialized.current`。如果 **首次** `initializeApp()` 中 `loadConfig()` 还没回来就走到了 `runPostAuthInit` 之前，`isInitialized` 被提前设为 `true`（`runPostAuthInit` 末尾 L159），那么 token 提交后第二个 useEffect 会因为 `isInitialized.current === true` 而直接跳过。

实际分析看这种情况概率低，但竞争条件存在。

---

#### 断点 4：`ConnectingOverlay` 中的 "需要刷新页面" 提示暴露了问题

```
src/components/Common/ConnectingOverlay.tsx:98-100
```

代码中有这句提示：*"连接后，需要刷新一下页面进行初始化"*。这相当于承认了自动初始化不可靠，让用户手动兜底。

---

## 根因总结

**主要根因**：`submitToken` 在 HTTP/WebSocket 传输层没有做连接重建：
1. `submitToken` 只是存了 token + 发两个 HTTP 请求，没有重建 WebSocket
2. 首次加载时部分代码可能已经触发了 WebSocket 连接（用空 token 连接失败）
3. 后续的 `listen()` 调用可能复用失败的 WebSocket 状态

**次要根因**：`submitToken` 成功路径缺少 `loadConfig` 中的 modelProfileStore / sessionConfigStore 同步步骤，虽然 `runPostAuthInit` 能兜住，但状态窗口存在。

**表象根因**：`ConnectingOverlay` 渲染条件 `isConnecting || failed || needsToken` 任何信号没变，蒙板就不会消失。

## 修复方向

### 方案 A（最小改动）

在 `submitToken` 成功后，增加 transport 层重建：

```typescript
// configStore.ts - submitToken 成功分支
import { rebuildTransport, manualReconnect } from '@/services/transport';

set({ config, healthStatus, loading: false, isConnecting: false, connectionState: 'success' });

// 重建 WebSocket 连接，带上新 token
if (currentMode === 'http') {
  rebuildTransport();          // 重建 httpTransport 实例
  await manualReconnect();     // 立即连接 WebSocket
}
```

同时补充 `submitToken` 成功路径中缺失的 `modelProfiles` 同步逻辑。

### 方案 B（更健壮）

在 `submitToken` 成功后直接调用 `loadConfig` 完整路径，而非手动拼状态：

```typescript
submitToken: async (rawToken: string) => {
  const tokenMd5 = await md5Hex(rawToken);
  storeTokenMd5(tokenMd5);
  
  // 重建 transport 带上新 token
  if (currentMode === 'http') {
    rebuildTransport();
    await manualReconnect();
  }
  
  // 走完整 loadConfig 路径（含所有同步逻辑）
  await get().loadConfig();
}
```

这样可以复用 `loadConfig` 的全部成功路径逻辑，且 `loadConfig` 内部会设置 `connectionState`，触发 `useAppInit` 的第二个 useEffect。

### 方案 C（根因修复）

`useAppInit` 的第二个 useEffect 中的 `runPostAuthInit` 调用，在 Web 模式下应先确保 WebSocket 连接就绪：

```typescript
useEffect(() => {
  if (connectionState === 'success' && !isInitialized.current) {
    (async () => {
      if (currentMode === 'http') {
        // 确保 WebSocket 已连接（带上新 token）
        await manualReconnect();
      }
      await runPostAuthInit.current();
    })();
  }
}, [connectionState]);
```

## 建议

推荐 **方案 A + 方案 C 组合**：
- A：`submitToken` 中重建 transport，修复当前 token 提交后的连接状态
- C：`useAppInit` 中的 `connectionState` 监听加一层 WebSocket 保障
- 同时补上 `submitToken` 成功路径缺失的 `modelProfileStore` 同步
- 移除 `ConnectingOverlay` 中 "需要刷新页面" 的提示

最低成本修复**测试路径**：
1. `submitToken` 成功时补 rebuildTransport + manualReconnect
2. `useAppInit` 第二个 useEffect 中补 WebSocket 就绪保障
3. 补 modelProfileStore 同步