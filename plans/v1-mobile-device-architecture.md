# 第一版（V1）模块设计与规范：手机能力 × 跨设备联动 × 插件架构

日期：2026-11-16 ｜ 关联：mobile-web-first-analysis.md、plugin-spec-v2-host-proxy.md、kernel-5k-all-plugin-architecture.md

## V1 范围（一句话）

在现有 Polaris 插件架构上落地**四个 V1 模块**：手机原生能力桥、设备连接器、远程能力代理、手机本地 AI 对话；并冻结第一版**插件规范 v2.1**（能力声明 + 宿主代理 + 跨设备路由）。

## 模块一：Device Bridge（设备桥，Rust 系统插件）

**职责**：手机 App 与电脑后端之间的配对、隧道、能力代理。
- 配对：扫码（电脑显示二维码 = ws 地址 + 一次性配对 token + 设备名），手机扫码后交换长期 device token。
- 隧道：单条 WSS（复用 web server 的 WS + token 鉴权），多路复用 `invoke` / `event` / `stream` 三类帧。
- 能力代理：手机端 `host.invoke(cap, ...)` → 隧道 → 电脑端 bus dispatch → 结果回传。**默认拒绝清单**：文件系统写入、进程执行、窗口控制类能力需电脑端用户确认（复用 permission_prompt）。
- 电脑↔手机反向调用：电脑可调手机端注册的能力（如 `mobile.camera`、`mobile.location`、`mobile.notify`）——手机 App 内嵌同一 web 内核 + Capacitor 原生桥插件实现。

技术选型：复用现有 axum WS（event_broadcaster 同通道扩展 `device` 帧），不引入新服务；手机端用 Capacitor（已有安卓工程 gen/android，tauri mobile 亦可，但 Capacitor 对 web 内核更中性）。

## 模块二：Mobile Capabilities（手机能力插件，前端+Capacitor）

以**前端插件**形式提供 `mobile.*` 能力，内部用 Capacitor JS SDK：
- `mobile.camera`：拍照/选图（Camera）→ base64/临时文件
- `mobile.location`：定位（Geolocation）
- `mobile.notify`：本地通知 + 推送（LocalNotifications/Push）
- `mobile.clipboard` / `mobile.share` / `mobile.files` / `mobile.sensors`
- 规范：能力经 manifest `permissions.mobile: [...]` 声明；宿主代理按声明放行；未声明 = 拒绝 + 审计。

## 模块三：Remote Capability Proxy（远程能力代理，核心机制）

- 电脑端：`Device Bridge` 把本机 `router_list_caps` 全集（按白名单过滤）注册为手机端可见能力，前缀 `pc.<cap>`（如 `pc.fs.list`）。
- 手机端：`host.invoke('pc.fs.list', ...)` → 隧道 → 电脑执行 → 回传。
- 权限：电脑端按「设备 + capability」二级白名单；敏感能力（bash/write）默认需电脑端确认弹窗。
- 这一个机制 = "手机像电脑一样用全部电脑功能"，无需逐功能开发。

## 模块四：Standalone Mobile AI（手机独立 AI 对话插件）

- 前端插件 `mobile-ai-chat`：同一聊天面板组件 + **直连模型 API**（用户填 key/baseUrl，OpenAI/Anthropic 兼容）。
- 存储：OPFS/IndexedDB 本地存储插件（不依赖电脑）。
- 与电脑会话互不干扰；连上电脑后可切换到 `pc.*` 代理模式（同一 UI，数据源切换）。

## 插件规范 v2.1（增量）

```jsonc
{
  "contributes": {
    "capabilities": { ... },                    // 既有
    "connectors": {                             // 新：连接器声明（Device Bridge 即此类型插件）
      "transport": "wss", "discovery": "qrcode", "caps": "all-allowlisted"
    },
    "mobilePermissions": ["camera", "location", "notifications"]  // 新：手机原生能力声明
  }
}
```

- 宿主代理对象扩展：`host.device.*`（配对信息）、`host.remote.invoke(cap, ...)`（经隧道的远端调用）。
- 一切仍走 `host.invoke` 单一入口；新增的只是路由目标可以是「本机 / 已连接远端设备」。

## 技术选型（冻结）

| 项 | 选型 | 理由 |
|---|---|---|
| 手机壳 | Capacitor（包裹现有 web 内核） | 已有安卓工程为 tauri；Capacitor 对纯 web 内核更中性、插件生态全（camera/geo/push 现成） |
| 通道 | 复用 axum WS + token（设备帧扩展） | 不新增服务、鉴权同源 |
| 配对 | 二维码（ws url + one-time token） | 免手动填地址 |
| 推送 | Capacitor Push + 自建中继可选（V2） | V1 先本地通知 |
| 存储（手机独立模式） | OPFS/IndexedDB 插件 | 零依赖、web 内核原生 |

## 实施顺序

| 步骤 | 内容 | 验收 |
|---|---|---|
| V1.1 | Device Bridge Rust 侧：配对二维码 + 设备注册表 + 隧道帧路由（invoke/event/stream） | 电脑端可列出已配对设备 |
| V1.2 | Capacitor 壳工程：包裹现有前端，跑通「手机浏览器→App」 | App 打开即连配置的服务 |
| V1.3 | Remote Capability Proxy：`pc.*` 能力映射 + 二级白名单 + 敏感能力确认 | 手机可调电脑 fs.read 等 |
| V1.4 | Mobile Capabilities 插件（camera/notify/clipboard）+ 规范 v2.1 声明校验 | 插件可请求拍照并回传 |
| V1.5 | Standalone Mobile AI 对话插件（直连 API + OPFS） | 断网/不连电脑可用 |
| V1.6 | 联调：手机 App ↔ 电脑（能力代理+反向调用+热更新） | 端到端演示 |

## 明确不做（V1）

- iOS 包（先安卓验证链路）
- 推送服务器（先本地通知）
- 手机端运行 Rust 引擎（simple-ai 在手机端以「直连 API」形态替代）
