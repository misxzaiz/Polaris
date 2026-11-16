# 极简核 + 全插件架构方案（5k 核可行版）

日期：2026-11-16 ｜ 应对需求：一切功能由插件提供（含存储），核只记录文件锚点；默认 Web 模式、无本地进程 invoke；插件间能力交叉调用；支持 App/Web/桌面；支持热安装/热更新；核 ≤5k 行。

## 一、可行性结论

**可行，但形态要变**：不是把现有 165k 宿主“删到 5k”，而是**重新定义核 = 插件运行时 + 文件锚点记录器**，当前宿主里的业务全部降级为“系统插件”（与第三方插件同待遇）。

核心洞察：你的插件体系（cap 总线 + manifest + 前端 blob 面板）已经是全自定义插件框架，且有 154 个插件实证。要做的不是再造框架，而是把“核”收缩到只做 4 件事：

1. **Plugin Runtime**：加载/安装/卸载/热更新插件（含商城拉取）
2. **Bus**：cap.* 能力路由 + 权限 + 审计（存储也走总线，由存储插件实现）
3. **Anchor Store**：唯一的核内持久化——只记录“锚点文件”路径/指针（不存业务数据）
4. **Shell**：窗口/Web 壳 + 主题 + 把第一个插件（marketplace + storage）拉起来

## 二、架构

```
kernel/                        ← ≤5k 行
├── bus/                       cap 路由 + 权限 + 审计钩子        (~1.2k)
├── runtime/                   插件发现/安装/卸载/热更新/进程管理 (~1.5k)
├── anchor/                    文件锚点记录（jsonl 单写者）       (~0.4k)
├── transport/                 web http/ws + 桌面桥接（可选）     (~1.0k)
└── shell/                     窗口/主题/启动引导                (~0.9k)

plugins/                       ← 全部功能，含：
├── marketplace/               插件商城（安装/更新/签名校验）
├── storage-sqlite/            存储插件：会话/消息/索引（接管现 session_db 等）
├── ai-chat/                   聊天业务（现 ai_chat_core + claude/simple-ai 引擎调用侧）
├── ai-engines/                引擎适配（claude/simple-ai → 经 ai.callback 反向注册）
└── ...（现有 154 个）
```

关键机制（与你现有系统一一对应）：

| 需求 | 机制 |
|---|---|
| 一切功能由插件提供 | capability 由插件注册（`register_capability`），核内 bus 只路由不实现 |
| 含存储 | 新 `cap.storage`：内核只写“锚点/指针”，真正的 get/put/list 由 storage 插件实现；迁移期提供 SQLite 存储插件承接现有 session_db |
| 核只记录文件锚点 | `anchor/` 仅存 `{key → file_path, offset, plugin_id}` 指针，不存内容 |
| 指向商城 + 基础插件 | shell 启动 → 读 `anchors.json` → 无 marketplace 插件则自动安装（内置内嵌 zip 或内置 URL） |
| 默认 web 模式、无 invoke 本地进程 | transport 默认 http/ws（浏览器可跑），桌面壳只是“额外的 transport 适配器”，插件不感知 |
| 插件间交叉使用 | 插件 A 经 bus 调插件 B 注册的 capability（现有 bus_dispatch 白名单机制） |
| app/web/桌面 | 同一份前端内核跑在浏览器/tauri webview/mobile webview；桌面仅多一个桥接插件 |
| 热安装/热更新 | runtime 已有 installRemotePlugin/checkPluginUpdate；补“免重启 reload”：面板 blob 重新 fetch + registry 重载（前端面板已支持 blob 重载） |
| 核 ≤5k | 上述四件合计 ~5k 行（bus 1.2k + runtime 1.5k + anchor 0.4k + transport 1.0k + shell 0.9k） |

## 三、迁移路径（每步可编译、可验证、可回退）

| 步骤 | 内容 | 核行数变化 |
|---|---|---|
| S1 | 建 `kernel/`（前端）物理隔离 plugin-system/transport/core，eslint 边界 | 不减，先立界 |
| S2 | 抽 `cap.storage`：定义 storage 能力契约（get/put/list/delete/subscribe），先由核内 SQLite 适配器实现（行为不变） | +0.3k |
| S3 | **存储插件化**：SQLite 适配器迁出为 `storage-sqlite` 插件；核内 anchor 记录“当前 storage 插件 id + 数据文件指针”；session_db/turn_persist/dialog_index 的调用方全部改走 cap.storage | 核 -3.9k |
| S4 | **AI 业务插件化**：ai_chat_core/ask/form/nexus 等 Rust 编排迁为系统插件（经 cap.ai.chat 反向注册引擎能力）；claude/simple-ai 引擎适配器随迁 | 核 -10k+ |
| S5 | **前端业务插件化**：components/services/stores 剩余业务逐个出仓 | 前端核趋近 3k |
| S6 | **热更新**：面板/服务插件版本变更免重启（blob 重载 + capability 重注册）；桌面壳热重载 | — |
| S7 | 核行数审计达标（≤5k），发布“极简核”版本 | ✓ |

## 四、风险与对策

| 风险 | 对策 |
|---|---|
| 存储插件化后启动顺序（插件未起→无处读数据） | anchor 记录“bootstrap storage”内嵌实现；marketplace 插件就绪后热替换 |
| 引擎插件化中断流式 | AIEvent 协议原样保留，引擎插件经 streaming cap 转发；灰度单引擎切换 |
| 154 插件兼容 | cap 契约版本化（manifest `capVersion`），旧插件默认映射旧动作 |
| 安全（存储插件可读全部数据） | 与现状一致——现本就是同进程；新增：cap.storage 权限单独分级 |
| 工作量 | S1-S3 为最小可行内核（先达“架构正确”），S4-S7 分多个独立 PR 演进 |

## 五、明确不做 / 不建议

- **不建议引入 Extism/wasm 运行时**：154 个 TS/React 插件无法迁移，得不偿失。
- **不建议一步到位重写**：现有 cap 总线/插件服务已实证可行，重写会丢 154 插件生态。
- **核内不放任何业务语义**：anchor 只存指针；“会话”“消息”等概念全部在插件层。
