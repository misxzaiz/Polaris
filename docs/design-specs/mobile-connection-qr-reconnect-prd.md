# PRD：移动端二维码扫描连接与重连能力

> 版本：v1.1 ｜ 状态：已规划 ｜ 关联模块：`src/components/Settings/tabs/WebTab.tsx`、`src/mobile/MobileConnectionGate.tsx`、`polaris-pocket/src/pages/SettingsPage.tsx`、`polaris-pocket/src/pages/ChatPage.tsx`、`src/services/transport/`
> 关联后端：`src-tauri/src/web/middleware.rs`、`src-tauri/src/web/api/ws.rs`
> 设计决策：F3（连接状态栏与重连面板）已移除，替换为轻量状态行

---

## 1. 背景与问题

### 1.1 现状

Polaris 提供桌面端（Tauri）/ Web 独立服务两种运行模式，通过 HTTP + WebSocket 对外暴露 API 服务。移动端（polaris-mobile / polaris-pocket）需要连接到桌面端以获取 AI 代理、会话历史、任务调度等能力。

当前连接流程的问题：

1. **二维码不含 Token**：设置页 `WebTab.tsx` 的二维码只编码纯 URL（`http://ip:port`），用户扫码后仍需手动输入 Token，体验割裂。
2. **无扫码入口**：`MobileConnectionGate.tsx` 仅提供手动输入地址和 Token 的文本框，没有相机扫码功能，移动端首次连接操作繁琐。
3. **连接后无管理入口**：连接成功后用户进入主界面，无法方便地查看连接状态、断开或切换服务器。若连接断开，只能通过重新加载页面回到初始设置页。

### 1.2 用户场景

- **首次连接**：用户在桌面端打开设置页，看到含 Token 的二维码；手机打开 App，点击扫码，扫描桌面端二维码，自动填入 URL 和 Token，一键连接。
- **日常使用**：手机 App 顶栏显示连接状态（绿点/红点），点击可查看连接详情、手动重连、断开或切换服务器。
- **断线恢复**：网络波动导致连接断开后，用户可在 App 内手动触发重连，无需重新扫码或输入地址。

### 1.3 目标

1. 桌面端 Web 设置页二维码嵌入 Token 信息，手机扫码即可完成完整连接配置
2. 手机 App 初始连接界面提供相机扫码入口，支持自动填入 URL + Token
3. 手机 App 主界面提供连接状态指示器和重新连接设置面板

---

## 2. 范围

### 2.1 In Scope

| 编号 | 特性 | 描述 |
|---|---|---|
| F1 | 二维码含 Token | `WebTab.tsx` 二维码内容从纯 URL 升级为 `http://ip:port?token=xxx` |
| F2 | 手机扫码连接 | `MobileConnectionGate.tsx` 新增扫码按钮 + 相机取景框，扫描后自动填入 URL 和 Token |
| F3 | 轻量连接状态行 | `MobileConnectionGate.tsx` 设置页输入框上方增加一行当前状态 + 断开按钮 |
| F4 | polaris-pocket 连接管理 | `SettingsPage.tsx` 增加"桌面端连接"区块（含扫码） |

### 2.2 Out of Scope

- WebSocket 自动重连逻辑优化（已有 `httpTransport.ts` 的指数退避 + 唤醒探测）
- 多桌面端同时连接管理
- 二维码有效期 / 一次性 Token 机制
- 桌面端扫码连接手机端（反向连接）

---

## 3. 详细需求

### F1. 二维码含 Token

**文件**：`src/components/Settings/tabs/WebTab.tsx`

**改动**：

1. 二维码的 `value` 从 `selectedAddress` 改为在 URL 后追加 `?token=<raw_token>`：

```tsx
// 当前
<QRCode value={selectedAddress} size={160} />

// 改为
const qrValue = token 
  ? `${selectedAddress}?token=${encodeURIComponent(token)}` 
  : selectedAddress;
<QRCode value={qrValue} size={160} />
```

2. 二维码下方增加提示文案："二维码已包含 Token 信息，可直接扫码连接"

3. 当 Token 为空时，二维码保持纯 URL 不变，并提示"未设置 Token，扫码后需手动输入"

**Token 嵌入约定**：

```
http://192.168.1.10:9830?token=abc123def456
```

- `token` 参数值为**原始 Token**（非 MD5）
- 手机端扫描后提取原始 Token，前端计算 MD5 后存入 `localStorage`（复用 `auth.ts` 的 `md5Hex`）
- 向后兼容：已有 Token 配置的用户升级后二维码自动升级

**验收**：
- 设置页 Token 有值时，二维码扫码内容包含 `?token=xxx`
- Token 为空时，二维码与当前一致（纯 URL）
- Token 变更时二维码自动刷新

---

### F2. 手机扫码连接

**文件**：`src/mobile/MobileConnectionGate.tsx`

**新增依赖**：`html5-qrcode`（轻量，无框架依赖，直接操作 Camera API）

**UI 改动**：

1. **连接设置页顶部新增扫码按钮**：在"服务地址"输入框上方添加一行扫码入口

```
┌──────────────────────────────────────┐
│  连接 Polaris 服务                     │
│                                       │
│  [📷 扫描桌面端二维码]  ← 新扫码按钮   │
│  ─────── 或手动输入 ───────            │
│  服务地址  [________________________] │
│  访问 Token [________________________] │
│  ...                                   │
└──────────────────────────────────────┘
```

2. **点击扫码按钮 → 弹出相机取景框**：全屏半透明遮罩 + 中央扫描框

```
┌──────────────────────────────────────┐
│  ┌──────────────────────────────┐    │
│  │                              │    │
│  │        [相机取景框]           │    │
│  │                              │    │
│  │                              │    │
│  └──────────────────────────────┘    │
│     将二维码对准框内扫描              │
│                                       │
│  [取消]                               │
└──────────────────────────────────────┘
```

3. **扫描成功后的自动填入**：

```typescript
// 解析 URL
const url = new URL(scannedText);
const serverUrl = `${url.protocol}//${url.host}`;
const token = url.searchParams.get('token') || '';

// 自动填入
setServerInput(serverUrl);
if (token) {
  setTokenInput(token);
  // 立即尝试连接
  await saveConnectionWithToken(serverUrl, token);
}
```

4. **扫码失败处理**：提示"无法识别此二维码，请重试或手动输入"

5. **相机权限拒绝**：提示"需要相机权限才能扫码，请在系统设置中开启"，并提供"手动输入"回退

**html5-qrcode 集成方案**：

```typescript
import { Html5Qrcode } from 'html5-qrcode';

const scanner = new Html5Qrcode('qr-reader');
scanner.start(
  { facingMode: 'environment' },
  { fps: 10, qrbox: { width: 250, height: 250 } },
  (decodedText) => {
    // 扫描成功 → 解析 URL + Token → 自动填入
    scanner.stop();
    setShowScanner(false);
    handleScanResult(decodedText);
  },
  () => { /* 不显示扫描失败，只显示成功 */ }
);
```

**验收**：
- 连接设置页有扫码按钮，样式清晰
- 点击扫码按钮打开相机取景框，后置摄像头优先
- 扫描含 Token 的二维码后自动填入 URL 和 Token 并触发连接
- 扫描纯 URL 二维码（无 Token）后自动填入 URL，Token 输入框留空
- 相机权限被拒时给出友好提示，回退到手动输入
- 手动输入功能完整保留

---

### F3. 轻量连接状态行

**文件**：`src/mobile/MobileConnectionGate.tsx`

**设计**：

在连接设置页（`showSettings === true`）的页面标题下方、扫码按钮上方，增加一行轻量状态提示：

```
┌──────────────────────────────────────┐
│  连接 Polaris 服务                     │
│                                       │
│  🟢 已连接 192.168.1.10:9830  [断开]  │  ← 新增（仅已连接时显示）
│                                       │
│  [📷 扫描二维码]                      │
│  ─────── 或手动输入 ───────            │
│  ...                                   │
└──────────────────────────────────────┘
```

- 仅当 `connected === true` 时显示该行
- 点击「断开」调用已有的 `handleDisconnect`
- 断开后该行消失，回到纯输入状态
- 改动量：约 10 行，无新增组件

**验收**：
- 连接成功后，设置页顶部显示状态行
- 状态行显示服务器地址和连接状态
- 点击【断开】回到输入模式
- 页面刷新后重新检测连接，若已连接则显示状态行

---

### F4. polaris-pocket 连接管理

**文件**：`polaris-pocket/src/pages/SettingsPage.tsx`

**改动**：

新增"桌面端连接"区块，位于"AI 供应商"和"Personal Hub"之间：

```
┌──────────────────────────────────────┐
│  📡 桌面端连接                        │
│                                       │
│  [📷 扫码连接]                        │
│  ─────── 或手动输入 ───────            │
│  服务地址  [________________________] │
│  访问 Token [________________________] │
│                                       │
│  [保存并连接]                         │
│                                       │
│  🟢 已连接 192.168.1.10:9830 [断开] │
│                                       │
│  ─ 最近连接 ─                         │
│  192.168.1.10:9830  [×]              │
└──────────────────────────────────────┘
```

该区块复用 `MobileConnectionGate` 的扫码/输入/连接/断开逻辑，通过 props 或 store 注入。
由于 polaris-pocket 的 SettingsPage 是独立 UI（非复用主项目的组件树），需要将 `MobileConnectionGate` 中的连接逻辑抽取为可复用的 hook 或工具函数。

**ChatPage 不做改动**：
- polaris-pocket 的 ChatPage 已有完善的独立 AI 直连能力
- 桌面端连接代理模式会增加复杂度，且与 pocket
\n该区块复用 `MobileConnectionGate` 的扫码/输入/连接/断开逻辑，通过 props 或 store 注入。\n由于 polaris-pocket 的 SettingsPage 是独立 UI（非复用主项目的组件树），需要将 `MobileConnectionGate` 中的连接逻辑抽取为可复用的 hook 或工具函数。\n\n**ChatPage 不做改动**：\n- polaris-pocket 的 ChatPage 已有完善的独立 AI 直连能力\n- 桌面端连接代理模式会增加复杂度，且与 pocket 的"轻量独立工具"定位不符\n- 连接后用途：pocket 用户可通过设置页连接桌面端，用于通过桌面端 API 查询会话/任务/待办（非聊天代理）\n\n**验收**：\n- polaris-pocket 设置页可完成桌面端连接的扫码/输入/连接/断开\n- 扫码/输入/连接逻辑与主项目 MobileConnectionGate 一致\n- ChatPage 保持独立直连模式不变化"}, {"oldText": "## 4. 交互设计\n\n### 4.1 完整用户流程\n\n```\n[桌面端] 用户打开设置 → Web 页\n  │\n  ├─ 配置 Token（可选）\n  ├─ 二维码自动生成（含 URL + Token）\n  └─ 用户将二维码展示给手机\n      │\n      ▼\n[手机端] 首次打开 App\n  │\n  ├─ 显示连接设置页\n  ├─ 点击\"扫码\"按钮\n  ├─ 扫描桌面端二维码\n  │   ├─ 成功 → 自动填入 URL + Token → 发起连接\n  │   └─ 失败 → 提示重试 / 回退手动输入\n  ├─ 连接成功 → 进入主界面\n  │\n  ▼\n[日常使用] 手机 App 主界面\n  │\n  ├─ 顶栏显示连接状态\n  ├─ 网络波动断开 → 状态变红\n  ├─ 用户点击设置 → 弹出连接面板\n  │   ├─ 点击\"重新连接\" → 立即重连\n  │   ├─ 点击\"断开连接\" → 回到设置页\n  │   └─ 点击\"切换服务器\" → 回到设置页（可重新扫码）\n  └─ 连接恢复 → 状态变绿，继续使用\n```\n\n### 4.2 界面状态矩阵\n\n| 场景 | 连接设置页 | 主界面 | 连接面板 |\n|---|---|---|---|\n| 首次打开无配置 | 显示扫码 + 手动输入 | - | - |\n| 扫描成功 | 自动填入并连接 | - | - |\n| 连接成功 | - | 显示 ✅ 状态栏 | 已连接状态 |\n| 连接断开 | - | 显示 ❌ 状态栏 + 断线提示 | 可重新连接 |\n| 手动断开 | 显示扫码 + 手动输入（历史保留） | - | - |\n| 切换服务器 | 显示扫码 + 手动输入（历史保留） | - | - |", "newText": "## 4. 交互设计\n\n### 4.1 完整用户流程\n\n```\n[桌面端] 用户打开设置 → Web 页\n  │\n  ├─ 配置 Token（可选）\n  ├─ 二维码自动生成（含 URL + Token）\n  └─ 用户将二维码展示给手机\n      │\n      ▼\n[手机端] 首次打开 App\n  │\n  ├─ 显示连接设置页\n  ├─ 点击\"扫码\"按钮\n  ├─ 扫描桌面端二维码\n  │   ├─ 成功 → 自动填入 URL + Token → 发起连接\n  │   └─ 失败 → 提示重试 / 回退手动输入\n  ├─ 连接成功 → 进入主界面\n  │   └─ 若需断开 → 回到设置页 → 顶部显示连接状态行\n  │\n  ▼\n[日常使用]\n  ├─ 网络波动断开 → 自动重连（指数退避，无需用户干预）\n  ├─ 用户主动断开 → 回到设置页 → 可重新扫码/输入\n  └─ 刷新页面 → 自动检测已保存的 URL/Token → 重新连接\n```\n\n### 4.2 界面状态矩阵\n\n| 场景 | 连接设置页 |\n|---|---|\n| 首次打开无配置 | 纯输入表单 + 扫码按钮 |\n| 扫描成功 | 自动填入并连接 → 进入主界面 |\n| 已连接再进入设置页 | 顶部显示状态行 + 断开按钮 |\n| 手动断开 | 状态行消失，回到纯输入表单 |\n| 历史记录点击 | 自动填入 URL 和 Token，尝试连接 |"}, {"oldText": "## 5. 实施计划\n\n| 阶段 | 内容 | 预估 | 依赖 |\n|---|---|---|---|\n| P1 | F1 二维码含 Token（WebTab.tsx） | 0.5d | 无 |\n| P2 | F2 扫码功能（MobileConnectionGate.tsx + html5-qrcode） | 1.5d | P1 |\n| P3 | F3 连接状态栏 + 重连面板（MobileConnectionGate.tsx） | 1d | P2 |\n| P4 | F4 polaris-pocket 连接管理（SettingsPage + ChatPage） | 1d | P3 |\n| P5 | 联调 + 测试（扫码解析、连接断开重连流程） | 1d | P1-P4 |\n\n**总计**：约 5 人日。", "newText": "## 5. 实施计划\n\n| 阶段 | 内容 | 预估 | 依赖 |\n|---|---|---|---|\n| P1 | F1 二维码含 Token（WebTab.tsx） | 0.5d | 无 |\n| P2 | F2 扫码功能（MobileConnectionGate.tsx + html5-qrcode） | 1.5d | P1 |\n| P3 | F3 轻量状态行（MobileConnectionGate.tsx） + F4 polaris-pocket | 1d | P2 |\n| P4 | 联调 + 测试 | 0.5d | P1-P3 |\n\n**总计**：约 3.5 人日。"}, {"oldText": "| 风险 | 影响 | 缓解 |\n|---|---|---|\n| 手机浏览器 getUserMedia 兼容性（iOS Safari 限制） | 扫码功能不可用 | 检测 `navigator.mediaDevices.getUserMedia` 可用性，不可用时隐藏扫码按钮，仅展示手动输入 |\n| iOS 上 html5-qrcode 性能问题 | 扫描卡顿 | 降级 fps 到 5，使用 `facingMode: 'environment'` 优先调用后置摄像头的低分辨率模式 |\n| Token 明文出现在 URL 中（局域网场景） | 中间人可截获 Token | 局域网场景风险低；若需增强可在二维码中只放 Token 的 MD5（但 WebTab 需先计算 MD5，再加一层约定） |\n| polaris-pocket 连接态与独立态切换的状态丢失 | 用户输入丢失 | 断开连接时保留当前会话在 localStorage，重连后不自动清空 |\n| 历史记录中 Token MD5 过期（服务端 Token 变更） | 历史记录无法自动连接 | 使用历史记录连接时，如果返回 401，提示 Token 已失效，引导用户重新扫码或输入新 Token |", "newText": "| 风险 | 影响 | 缓解 |\n|---|---|---|\n| 手机浏览器 getUserMedia 兼容性（iOS Safari 限制） | 扫码功能不可用 | 检测 `navigator.mediaDevices.getUserMedia` 可用性，不可用时隐藏扫码按钮，仅展示手动输入 |\n| iOS 上 html5-qrcode 性能问题 | 扫描卡顿 | 降级 fps 到 5，使用 `facingMode: 'environment'` 优先调用后置摄像头的低分辨率模式 |\n| Token 明文出现在 URL 中（局域网场景） | 中间人可截获 Token | 局域网场景风险低；若需增强可在二维码中只放 Token 的 MD5（但 WebTab 需先计算 MD5，再加一层约定） |\n| polaris-pocket 复用连接逻辑的模块耦合 | 代码重复或耦合 | 将连接逻辑抽取为独立 hook `useConnection`，主项目和 pocket 共用 |\n| 历史记录中 Token MD5 过期（服务端 Token 变更） | 历史记录无法自动连接 | 使用历史记录连接时，如果返回 401，提示 Token 已失效，引导用户重新扫码或输入新 Token |"}, {"oldText": "## 7. 验收标准\n\n1. 桌面端设置页二维码包含 `?token=xxx`，手机扫码后自动解析 URL 和 Token\n2. 手机 App 连接设置页有扫码按钮，点击后打开相机，扫描成功自动填入并连接\n3. 手机 App 主界面顶部显示连接状态（绿/红/灰圆点）\n4. 点击状态区域弹出连接设置面板，支持\"重新连接\"、\"断开连接\"、\"切换服务器\"\n5. polaris-pocket 设置页可配置桌面端连接，连接后 ChatPage 消息走桌面端代理\n6. 手动输入功能完整保留，与扫码互为回退\n7. 断开连接后回到设置页，历史记录保留\n8. 相机权限被拒时友好提示，扫码功能降级为手动输入\n9. 所有改动 TypeScript 编译零错误\n10. 现有桌面端和 Web 端功能无回归", "newText": "## 7. 验收标准\n\n1. 桌面端设置页二维码包含 `?token=xxx`，手机扫码后自动解析 URL 和 Token\n2. 手机 App 连接设置页有扫码按钮，点击后打开相机，扫描成功自动填入并连接\n3. 连接成功后，设置页顶部显示轻量状态行（服务器地址 + 断开按钮）\n4. polaris-pocket 设置页可配置桌面端连接（扫码/输入/连接/断开）\n5. 手动输入功能完整保留，与扫码互为回退\n6. 断开连接后回到设置页，历史记录保留\n7. 相机权限被拒时友好提示，扫码功能降级为手动输入\n8. 所有改动 TypeScript 编译零错误\n9. 现有桌面端和 Web 端功能无回归"}, {"oldText": "## 8. 关键文件清单\n\n| 文件 | 改动类型 |\n|---|---|\n| `src/components/Settings/tabs/WebTab.tsx` | 修改：二维码值追加 Token |\n| `src/mobile/MobileConnectionGate.tsx` | 修改：新增扫码、连接状态栏、重连面板 |\n| `src/mobile/platform.ts` | 可能修改：新增扫码能力检测 |\n| `polaris-pocket/src/pages/SettingsPage.tsx` | 修改：新增桌面端连接区块 |\n| `polaris-pocket/src/pages/ChatPage.tsx` | 修改：新增连接状态栏 + 代理模式切换 |\n| `polaris-mobile/src-tauri/src/lib.rs` | 可能修改：添加相机权限 Tauri 插件 |\n| `package.json` | 修改：新增 `html5-qrcode` 依赖 |\n| `src-tauri/src/web/middleware.rs` | 无需改动（WS 已支持 `?token=` 参数） |\n| `src/services/transport/auth.ts` | 可能修改：新增 URL 解析 Token 工具函数 |", "newText": "## 8. 关键文件清单\n\n| 文件 | 改动类型 |\n|---|---|\n| `src/components/Settings/tabs/WebTab.tsx` | 修改：二维码值追加 Token |\n| `src/mobile/MobileConnectionGate.tsx` | 修改：新增扫码、轻量状态行 |\n| `src/mobile/platform.ts` | 可能修改：新增扫码能力检测 |\n| `polaris-pocket/src/pages/SettingsPage.tsx` | 修改：新增桌面端连接区块 |\n| `polaris-mobile/src-tauri/src/lib.rs` | 可能修改：添加相机权限 Tauri 插件 |\n| `package.json` | 修改：新增 `html5-qrcode` 依赖 |\n| `src-tauri/src/web/middleware.rs` | 无需改动（WS 已支持 `?token=` 参数） |\n| `src/services/transport/auth.ts` | 可能修改：新增 URL 解析 Token 工具函数 |"}]

---

## 4. 交互设计

### 4.1 完整用户流程

```
[桌面端] 用户打开设置 → Web 页
  │
  ├─ 配置 Token（可选）
  ├─ 二维码自动生成（含 URL + Token）
  └─ 用户将二维码展示给手机
      │
      ▼
[手机端] 首次打开 App
  │
  ├─ 显示连接设置页
  ├─ 点击"扫码"按钮
  ├─ 扫描桌面端二维码
  │   ├─ 成功 → 自动填入 URL + Token → 发起连接
  │   └─ 失败 → 提示重试 / 回退手动输入
  ├─ 连接成功 → 进入主界面
  │
  ▼
[日常使用] 手机 App 主界面
  │
  ├─ 顶栏显示连接状态
  ├─ 网络波动断开 → 状态变红
  ├─ 用户点击设置 → 弹出连接面板
  │   ├─ 点击"重新连接" → 立即重连
  │   ├─ 点击"断开连接" → 回到设置页
  │   └─ 点击"切换服务器" → 回到设置页（可重新扫码）
  └─ 连接恢复 → 状态变绿，继续使用
```

### 4.2 界面状态矩阵

| 场景 | 连接设置页 | 主界面 | 连接面板 |
|---|---|---|---|
| 首次打开无配置 | 显示扫码 + 手动输入 | - | - |
| 扫描成功 | 自动填入并连接 | - | - |
| 连接成功 | - | 显示 ✅ 状态栏 | 已连接状态 |
| 连接断开 | - | 显示 ❌ 状态栏 + 断线提示 | 可重新连接 |
| 手动断开 | 显示扫码 + 手动输入（历史保留） | - | - |
| 切换服务器 | 显示扫码 + 手动输入（历史保留） | - | - |

### 4.3 视觉风格

遵循 Polaris 设计原则（见 PRODUCT.md）：

- **精准克制**：连接状态栏不占过多空间，单行高度 36px
- **移动端原生层次**：设置面板使用底部弹出（Bottom Sheet），符合移动端操作习惯
- **状态清晰**：绿/红/灰三色圆点 + 文本标签，颜色非唯一标识
- **大触控目标**：扫码按钮 ≥ 44px，列表项点击区域 ≥ 40px

---

## 5. 实施计划

| 阶段 | 内容 | 预估 | 依赖 |
|---|---|---|---|
| P1 | F1 二维码含 Token（WebTab.tsx） | 0.5d | 无 |
| P2 | F2 扫码功能（MobileConnectionGate.tsx + html5-qrcode） | 1.5d | P1 |
| P3 | F3 连接状态栏 + 重连面板（MobileConnectionGate.tsx） | 1d | P2 |
| P4 | F4 polaris-pocket 连接管理（SettingsPage + ChatPage） | 1d | P3 |
| P5 | 联调 + 测试（扫码解析、连接断开重连流程） | 1d | P1-P4 |

**总计**：约 5 人日。

---

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 手机浏览器 getUserMedia 兼容性（iOS Safari 限制） | 扫码功能不可用 | 检测 `navigator.mediaDevices.getUserMedia` 可用性，不可用时隐藏扫码按钮，仅展示手动输入 |
| iOS 上 html5-qrcode 性能问题 | 扫描卡顿 | 降级 fps 到 5，使用 `facingMode: 'environment'` 优先调用后置摄像头的低分辨率模式 |
| Token 明文出现在 URL 中（局域网场景） | 中间人可截获 Token | 局域网场景风险低；若需增强可在二维码中只放 Token 的 MD5（但 WebTab 需先计算 MD5，再加一层约定） |
| polaris-pocket 连接态与独立态切换的状态丢失 | 用户输入丢失 | 断开连接时保留当前会话在 localStorage，重连后不自动清空 |
| 历史记录中 Token MD5 过期（服务端 Token 变更） | 历史记录无法自动连接 | 使用历史记录连接时，如果返回 401，提示 Token 已失效，引导用户重新扫码或输入新 Token |

---

## 7. 验收标准

1. 桌面端设置页二维码包含 `?token=xxx`，手机扫码后自动解析 URL 和 Token
2. 手机 App 连接设置页有扫码按钮，点击后打开相机，扫描成功自动填入并连接
3. 手机 App 主界面顶部显示连接状态（绿/红/灰圆点）
4. 点击状态区域弹出连接设置面板，支持"重新连接"、"断开连接"、"切换服务器"
5. polaris-pocket 设置页可配置桌面端连接，连接后 ChatPage 消息走桌面端代理
6. 手动输入功能完整保留，与扫码互为回退
7. 断开连接后回到设置页，历史记录保留
8. 相机权限被拒时友好提示，扫码功能降级为手动输入
9. 所有改动 TypeScript 编译零错误
10. 现有桌面端和 Web 端功能无回归

---

## 8. 关键文件清单

| 文件 | 改动类型 |
|---|---|
| `src/components/Settings/tabs/WebTab.tsx` | 修改：二维码值追加 Token |
| `src/mobile/MobileConnectionGate.tsx` | 修改：新增扫码、连接状态栏、重连面板 |
| `src/mobile/platform.ts` | 可能修改：新增扫码能力检测 |
| `polaris-pocket/src/pages/SettingsPage.tsx` | 修改：新增桌面端连接区块 |
| `polaris-pocket/src/pages/ChatPage.tsx` | 修改：新增连接状态栏 + 代理模式切换 |
| `polaris-mobile/src-tauri/src/lib.rs` | 可能修改：添加相机权限 Tauri 插件 |
| `package.json` | 修改：新增 `html5-qrcode` 依赖 |
| `src-tauri/src/web/middleware.rs` | 无需改动（WS 已支持 `?token=` 参数） |
| `src/services/transport/auth.ts` | 可能修改：新增 URL 解析 Token 工具函数 |