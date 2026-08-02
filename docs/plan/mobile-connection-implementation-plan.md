# 实施计划：移动端二维码扫描连接

> 基于 PRD `docs/design-specs/mobile-connection-qr-reconnect-prd.md` v1.1
> 范围：F1（二维码含 Token）+ F2（扫码连接）+ F3（轻量状态行）+ F4（polaris-pocket 连接管理）

---

## 总览

| 阶段 | 内容 | 预估 | 涉及文件 |
|---|---|---|---|
| P1 | F1：二维码含 Token | 0.5d | `WebTab.tsx` |
| P2 | F2：扫码功能 + 连接逻辑抽取 | 1.5d | `MobileConnectionGate.tsx`、`package.json`、`auth.ts`、`platform.ts` |
| P3 | F3：轻量状态行 + F4：polaris-pocket | 1d | `MobileConnectionGate.tsx`、`polaris-pocket/src/pages/SettingsPage.tsx` |
| P4 | 联调 + 测试 | 0.5d | 全链路 |

**总计**：约 **3.5 人日**

---

## P1：二维码含 Token（0.5d）

### 目标
`WebTab.tsx` 的二维码内容从纯 URL 升级为 `http://ip:port?token=raw_token`。

### 改动文件

**`src/components/Settings/tabs/WebTab.tsx`**

#### 1.1 获取当前 Token 值

```typescript
// 在组件内读取 web.token
const token = web.token ?? '';
```

Token 当前已通过 `config.web.token` 获取，无需新增 store。

#### 1.2 构建二维码 URL

```typescript
// 当前
<QRCode value={selectedAddress} size={160} />

// 改为
const qrValue = token 
  ? `${selectedAddress}?token=${encodeURIComponent(token)}`
  : selectedAddress;
<QRCode value={qrValue} size={160} />
```

#### 1.3 二维码下方提示文案

在二维码下方、原有的 `qrHint` 上方增加条件提示：

```typescript
{token ? (
  <p className="text-xs text-text-tertiary text-center">
    ✅ 二维码已包含 Token 信息，手机扫码即可自动完成鉴权
  </p>
) : (
  <p className="text-xs text-text-tertiary text-center">
    ⚠️ 未设置 Token，二维码仅包含 URL，扫码后需手动输入 Token
  </p>
)}
```

#### 1.4 验收

- Token 有值时，复制二维码内容应得到 `http://ip:port?token=xxx`
- Token 为空时，二维码内容保持纯 URL
- Token 输入变化时二维码自动刷新（React 响应式已保证）
- 向后兼容：已有 Token 配置的用户升级后自动生效

---

## P2：扫码功能 + 连接逻辑抽取（1.5d）

### 目标
`MobileConnectionGate.tsx` 新增扫码按钮 + 相机取景框，扫描后自动填入 URL 和 Token。同时将连接逻辑抽取为可复用 hook。

### 改动文件

#### 2.1 新增依赖

**`package.json`**

```json
"dependencies": {
  "html5-qrcode": "^2.6.0"
}
```

#### 2.2 新增工具函数

**`src/services/transport/auth.ts`** 新增：

```typescript
/**
 * 从二维码扫描结果中解析服务地址和 Token。
 * 格式: http://ip:port?token=xxx
 * 或纯 URL: http://ip:port
 */
export function parseQrContent(qrContent: string): {
  serverUrl: string;
  token: string;
} {
  try {
    const url = new URL(qrContent);
    const serverUrl = `${url.protocol}//${url.host}`;
    const token = url.searchParams.get('token') || '';
    return { serverUrl, token };
  } catch {
    // 不是合法的 URL，可能只是纯文本
    return { serverUrl: qrContent, token: '' };
  }
}
```

#### 2.3 扫码能力检测

**`src/mobile/platform.ts`** 新增：

```typescript
/** 检测是否支持二维码扫描（需要 getUserMedia） */
export function supportsQrScanning(): boolean {
  return !!(
    typeof navigator !== 'undefined' &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );
}
```

#### 2.4 抽取可复用连接 Hook

**新文件：`src/mobile/useConnection.ts`**

将 `MobileConnectionGate.tsx` 中的连接逻辑抽取为独立 hook，使主项目 `MobileConnectionGate` 和 polaris-pocket 的 `SettingsPage` 都能复用：

```typescript
interface UseConnectionReturn {
  serverUrl: string;
  serverInput: string;
  setServerInput: (v: string) => void;
  tokenInput: string;
  setTokenInput: (v: string) => void;
  connected: boolean;
  checking: boolean;
  error: string | null;
  config: Config | null;
  history: ServerHistoryEntry[];
  connect: (url: string, token: string) => Promise<void>;
  disconnect: () => Promise<void>;
  pickFromHistory: (entry: ServerHistoryEntry) => Promise<void>;
  removeHistoryEntry: (url: string) => void;
  reloadHistory: () => void;
}
```

核心逻辑：

```typescript
export function useConnection(): UseConnectionReturn {
  // ... 从 MobileConnectionGate 提取的状态 + 方法
  // connect: storeServerUrl → storeTokenMd5 → rebuildTransport → checkConnection
  // disconnect: disconnect → clearServerUrl → rebuildTransport
  // pickFromHistory: 同现有逻辑
  
  return {
    serverUrl, serverInput, setServerInput,
    tokenInput, setTokenInput,
    connected, checking, error, config, history,
    connect, disconnect, pickFromHistory,
    removeHistoryEntry, reloadHistory,
  };
}
```

#### 2.5 MobileConnectionGate 扫码 UI

**`src/mobile/MobileConnectionGate.tsx`** 改动：

**扫码按钮**（在页面标题下方）：

```tsx
{supportsQrScanning() && (
  <div className="mb-4">
    <button
      onClick={() => setShowScanner(true)}
      className="w-full py-3 px-4 rounded-xl border-2 border-dashed border-primary/40
                 bg-primary/5 text-primary font-medium text-sm
                 flex items-center justify-center gap-2"
    >
      <span className="text-lg">📷</span>
      扫描桌面端二维码
    </button>
  </div>
)}
```

**相机取景框覆盖层**（条件渲染）：

```tsx
{showScanner && (
  <div className="fixed inset-0 z-50 bg-black flex flex-col">
    <div className="flex items-center justify-between p-4">
      <button onClick={stopScanner} className="text-white/80 text-sm">取消</button>
      <span className="text-white text-sm font-medium">扫描二维码</span>
      <span className="w-12" />
    </div>
    <div className="flex-1 flex items-center justify-center">
      <div id="qr-reader" className="w-64 h-64" />
    </div>
    <p className="text-white/50 text-center text-sm pb-8">
      将二维码对准框内自动扫描
    </p>
  </div>
)}
```

**扫码启动/停止逻辑**：

```typescript
const scannerRef = useRef<Html5Qrcode | null>(null);

const startScanner = useCallback(async () => {
  const scanner = new Html5Qrcode('qr-reader');
  scannerRef.current = scanner;
  await scanner.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 250, height: 250 } },
    (decodedText) => {
      // 扫描成功
      scanner.stop();
      scannerRef.current = null;
      setShowScanner(false);
      const { serverUrl, token } = parseQrContent(decodedText);
      setServerInput(serverUrl);
      if (token) {
        setTokenInput(token);
        // 自动连接
        connect(serverUrl, token);
      } else {
        // 无 Token，只填 URL，用户手动输入 Token
        showToast('已填入服务地址，请输入 Token 后连接');
      }
    },
    () => { /* 非成功回调，不处理 */ }
  );
}, [connect]);
```

#### 2.6 相机权限降级

`startScanner` 用 try-catch 包裹，捕获 `NotAllowedError`：

```typescript
try {
  await startScanner();
} catch (err) {
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    setScannerError('需要相机权限才能扫码，请在系统设置中开启');
  } else {
    setScannerError('无法启动相机，请尝试手动输入');
  }
  setShowScanner(false);
}
```

#### 2.7 验收

- 支持扫码的设备显示扫码按钮，不支持的不显示
- 点击扫码按钮打开相机取景框，后置摄像头优先
- 扫描含 Token 的二维码后自动填入 URL 和 Token 并触发连接
- 扫描纯 URL 二维码后填入 URL，Token 留空
- 相机权限被拒时显示友好提示
- 手动输入功能完整保留

---

## P3：轻量状态行 + polaris-pocket（1d）

### 目标
- F3：连接设置页顶部增加轻量状态行
- F4：polaris-pocket 设置页接入桌面端连接

### 改动文件

#### 3.1 MobileConnectionGate 状态行

**`src/mobile/MobileConnectionGate.tsx`**

在 `showSettings` 页面中，`page-header` 下方、扫码按钮上方插入：

```tsx
{connected && (
  <div className="mb-4 px-4 py-3 rounded-xl bg-green/5 border border-green/20
                  flex items-center justify-between">
    <div className="flex items-center gap-2">
      <span className="w-2 h-2 rounded-full bg-green shadow-[0_0_6px_rgba(166,227,161,0.5)]" />
      <span className="text-sm text-green">已连接</span>
      <code className="text-xs text-text-tertiary">{serverUrl}</code>
    </div>
    <button
      onClick={handleDisconnect}
      className="text-xs text-danger/80 hover:text-danger"
    >
      断开
    </button>
  </div>
)}
```

#### 3.2 polaris-pocket 设置页

**`polaris-pocket/src/pages/SettingsPage.tsx`**

在"AI 供应商"和"Personal Hub"之间新增"桌面端连接"区块：

```tsx
// 第 1 步：引入连接 hook
// 由于 polaris-pocket 有独立的 tsconfig 和依赖树，
// 不能直接引用主项目的 src/mobile/useConnection.ts。
// 方案：将 useConnection hook 放在一个共享位置，
// 或在 polaris-pocket 内独立实现一份精简版（推荐，避免跨包依赖）

// 方案选择：polaris-pocket 内独立实现精简版
// 理由：polaris-pocket 已有自己的 auth.ts（复用主项目）、desktopTransport.ts，
// 连接逻辑只需 storeServerUrl + storeTokenMd5 + rebuildTransport + healthCheck，
// 约 30 行代码，不值得跨包共享。
```

新增区块：

```tsx
// 在 SettingsPage 的 return 中，AI 供应商 section 之后插入：
<section>
  <h3 className="mb-2.5 text-[15px] font-semibold">📡 桌面端连接</h3>
  <div className="rounded-[14px] border border-border bg-background-elevated p-4 shadow-[0_2px_8px_rgba(0,0,0,0.12)]">
    {/* 扫码按钮 - 需要相机权限检测 */}
    {supportsQrScanning && (
      <button onClick={openScanner} className="...">
        📷 扫码连接
      </button>
    )}
    
    {/* 手动输入 */}
    <Field label="服务地址">
      <input value={serverInput} onChange={...} placeholder="http://..." />
    </Field>
    <Field label="访问 Token">
      <input type="password" value={tokenInput} onChange={...} />
    </Field>
    
    <button onClick={connect} className="btn-primary">保存并连接</button>
    
    {/* 连接状态 */}
    {connected && (
      <div className="flex items-center justify-between mt-3 ...">
        <span>🟢 已连接 {serverUrl}</span>
        <button onClick={disconnect}>断开</button>
      </div>
    )}
    
    {/* 历史记录 */}
    {history.length > 0 && (
      <div className="mt-3">
        <span className="text-xs text-text-tertiary">最近连接</span>
        {history.map(entry => (
          <div key={entry.url} className="...">
            <span>{entry.url}</span>
            <button onClick={() => pickFromHistory(entry)}>连接</button>
          </div>
        ))}
      </div>
    )}
  </div>
</section>
```

#### 3.3 验收

- 主项目：连接成功后设置页顶部显示绿点 + 地址 + 断开按钮
- 主项目：点击断开回到纯输入模式
- polaris-pocket：设置页可扫码/输入/连接/断开
- polaris-pocket：连接状态显示在设置页内
- polaris-pocket：ChatPage 不受影响

---

## P4：联调 + 测试（0.5d）

### 测试场景

| # | 场景 | 步骤 | 预期 |
|---|---|---|---|
| 1 | 桌面端二维码含 Token | 设置 Token → 查看二维码 | 二维码内容含 `?token=xxx` |
| 2 | 桌面端二维码无 Token | 清空 Token → 查看二维码 | 纯 URL |
| 3 | 手机扫码含 Token 的二维码 | 扫描 → 自动填入 | URL 和 Token 自动填入，触发连接 |
| 4 | 手机扫码纯 URL 二维码 | 扫描 | URL 填入，Token 留空 |
| 5 | 相机权限拒绝 | 拒绝权限 → 扫码 | 友好提示，回退手动输入 |
| 6 | 手动输入连接 | 输入 URL + Token → 保存 | 连接成功 |
| 7 | 连接状态行 | 连接成功后回到设置页 | 顶部显示状态行 |
| 8 | 断开连接 | 点击断开 | 回到纯输入模式，历史保留 |
| 9 | 历史记录快速连接 | 点击历史条目 | 自动填入并连接 |
| 10 | polaris-pocket 连接 | 在设置页配置 | 显示连接状态 |
| 11 | 无扫码能力的浏览器 | 用不支持 getUserMedia 的浏览器 | 扫码按钮不显示 |

### 回归测试

- 桌面端 WebTab 设置页：所有现有功能无回归
- 移动端浏览器访问：无扫码能力，手动输入正常
- polaris-pocket 现有 AI 供应商、Personal Hub 配置无影响
- 已有历史记录的 Token 连接正常

---

## 依赖外部因素

| 外部依赖 | 说明 | 风险 |
|---|---|---|
| `html5-qrcode` npm 包 | 需添加到 `package.json` | 低，纯前端库，无原生依赖 |
| iOS Safari `getUserMedia` | iOS 15+ 支持，但需 `https` 或 `localhost` | 中，开发环境可能需用 https 隧道 |
| Tauri Android 相机权限 | `polaris-mobile` 需添加 `CAMERA` 权限到 AndroidManifest | 低，标准权限声明 |

---

## 文件改动清单（最终版）

| 文件 | 改动类型 | 改动量 | 关联 Feature |
|---|---|---|---|
| `src/components/Settings/tabs/WebTab.tsx` | 修改 | ~10 行 | F1 |
| `src/mobile/MobileConnectionGate.tsx` | 修改 | ~150 行 | F2, F3 |
| `src/mobile/useConnection.ts` | **新增** | ~80 行 | F2 |
| `src/mobile/platform.ts` | 修改 | ~5 行 | F2 |
| `src/services/transport/auth.ts` | 修改 | ~15 行 | F2 |
| `package.json` | 修改 | +1 行 | F2 |
| `polaris-pocket/src/pages/SettingsPage.tsx` | 修改 | ~80 行 | F4 |
| `polaris-mobile/src-tauri/gen/android/app/.../AndroidManifest.xml` | 修改 | +1 行 | F2 |