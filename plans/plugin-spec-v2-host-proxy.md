# 插件规范 v2：布局协作 + 声明式能力（i18n/主题/通知/存储）+ 宿主代理

日期：2026-11-16 ｜ 关联：layout-plugin-system-spec.md、kernel-5k-all-plugin-architecture.md

## 你的问题逐条回答

**1. 插件规范由谁决定——布局插件还是宿主？**
分两层：**结构规范由宿主定**（manifest 字段、area/slot 枚举、校验规则——这是契约，不能由某个插件定义）；**布局实例由布局插件定**（槽位树长什么样、默认放什么）。即：宿主定义"可以说什么"，布局插件决定"具体怎么摆"。

**2. 图标？**
已有：manifest `icon` 字段（lucide 名/相对路径/http/data URL，`isValidPluginIconValue` 校验）。

**3. i18n / 主题 / 消息通知——插件怎么"接受标识"并借助宿主或布局插件弹出？**
现有做法零散（ai-scheduler 自带 i18n.ts；通知走 chat-event）。规范化为**声明式能力 + 宿主代理**：

```jsonc
// manifest.contributes 新增（声明式，宿主代理执行，插件不自己实现）
"i18n":    { "locales": { "zh-CN": "./i18n/zh-CN.json", "en": "./i18n/en.json" } },
"theme":   { "tokens": { "accent": "#7c5cff" }, "dark": { "accent": "#9d7cff" } },  // 可选覆盖
"notifications": { "channels": ["toast", "system"] }                                 // 声明用哪些通道
```

- **i18n**：宿主 loader 安装插件时把 locales 合入 i18next（命名空间 = 插件 id）；插件内直接用宿主 `useTranslation`。标识 = 插件 id + key。
- **主题**：插件只声明 token 覆盖；宿主主题引擎应用（作用域限定插件面板根节点，CSS 变量注入）。插件不碰全局主题。
- **通知**：插件调 `host.notify({ channel, title, body })`（宿主代理统一弹 toast/系统通知）；声明里只写用到的 channel，越权由宿主拒绝。
- **布局弹窗/面板**：布局插件提供槽位；插件经 `panel` 声明位置，经 `host.openPanel(slotId)` 请求弹出（宿主/布局插件裁决）。

**4. 存储用存储插件？**
是。`cap.storage`（get/put/list/delete/subscribe），由存储插件实现；插件声明 `"storage": { "namespace": "abacus" }`，宿主代理自动加命名空间前缀——插件只能读写自己的命名空间。

**5. 各服务调用通过宿主代理，避免实现不一致？**
是。已有基础 = cap 总线 + `__POLARIS_HOST_INVOKE__` 白名单。规范升级为：**插件禁止直连任何宿主内部模块**（eslint + loader 校验），一切经：
- `host.invoke(cap, action, payload)` → 总线（权限+审计统一）
- `host.storage.*` / `host.notify(...)` / `host.i18n.t(...)` / `host.theme.tokens` / `host.layout.*` —— 宿主代理对象，由核或对应插件实现
- 插件间调用 = 同一 `host.invoke` 打到对方注册的 capability

**6. 避免开发乱七八糟的约束（强制的）**
- manifest schema 校验（安装时拒收）：新字段 i18n/theme/notifications/storage/layout 全部进 index.schema.json + plugin_service 校验。
- ESLint `no-restricted-imports`：插件源码禁止 `@/services/*`、`@/stores/*`、`@/components/*`（只能用 host 代理与声明能力）。
- 运行时：loader 后插件代码运行在代理对象上（现有 appCoreBridge 已具备），越权访问 reject + 审计。
- 布局槽位树校验：无环、slot 引用存在、position 枚举合法。

## 落地顺序

| 步骤 | 内容 |
|---|---|
| N1 | manifest schema v2 字段扩展 + plugin_service/loader 校验 |
| N2 | 宿主代理对象 `host.*`（notify/i18n/theme/storage/layout）+ eslint 边界 |
| N3 | 布局插件 layout-desk + LayoutHost 壳（读槽位树实时渲染） |
| N4 | 存储插件 storage-sqlite 接管 cap.storage（核只写锚点） |
| N5 | 示例插件改造 2-3 个（接入 i18n/主题/通知声明）+ 热更新联调 |

## 明确不做
- 不让布局插件定义 manifest 规范（它只是规范的消费者）。
- 不做 wasm/独立进程插件模型（154 个 TS 插件不兼容）。
