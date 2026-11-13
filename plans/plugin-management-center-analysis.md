# 插件管理中心改造分析（商城插件升级方案）

> 状态：**分析稿，未实施**。
> 背景：插件管理目前藏在设置页（第 7 个 tab）的折叠卡片里，开关不便、看不到插件启动的服务/端口、无法批量操作；卸载运行中插件时存在"服务占用端口/目录锁定删不掉"的体验问题。本文件分析现状、根因与改造方案，并评估以商城插件（polaris.marketplace）为承载的可行性。
> 结论先行：**推荐"商城插件升级为插件管理中心 + 设置页保留深度配置"的混合定位**。后端能力基本齐备，改造主要在面板层接线；前置决策 1 已定（状态口走 cap 整域放行，2026-11-13），其余 3 个待定（见 §5）。

---

## 1. 现状盘点

### 1.1 前端：设置页 PluginTab（`src/components/Settings/tabs/PluginTab.tsx`，1603 行）

- 入口层级深：`SettingsSidebar` 第 7 项（general → theme → … → **plugins** → …），tab 为本地 state，无路由/深链，进入成本高。
- 列表形态：折叠卡片（名称/版本/徽章/描述），展开后才见 views / MCP / AI 工具 / 引擎 / 权限 / configSchema 表单；**无搜索、无筛选、无虚拟化**，插件多时逐卡展开效率低。
- 开关：总启用 checkbox 在折叠卡头部；UI 面 / MCP 面 / 逐 server / 逐工具开关在展开区深处。
- **服务可观测性（最大缺口）**：`pluginServiceStore` 已实时持有每个服务的 state/pid/port/uptime/restartCount/lastError（`plugin.service.status` 事件回填），但 PluginTab 从不渲染；`pluginServiceManager.listStatus()/stopService()/restartService()` 有封装、**无任何 UI 调用**。用户想停某插件服务，只能禁用整个插件或卸载。
- 批量操作：无（`autoStartAll` 是内部机制，非用户操作面）。
- 卸载：原生 `window.confirm` → `uninstall_with_cleanup`（后端停服务+杀进程+删目录），过程黑盒，失败仅一句提示；确认文案未入 i18n。

### 1.2 后端：能力基本齐备，缺口在小颗粒度与透明度

- **状态模型**：installed = 目录存在（`plugins/<id>/plugin.json`）；enabled = `plugins/state.json` 布尔位；running = 仅 `contributes.services` 声明的后台服务由 **ServiceSupervisor** 管理（`Starting/Running/Stopping/Stopped/Error` 五态 + port/pid/uptime/restartCount/epoch/unavailableReason）。
- **ServiceSupervisor**（`src-tauri/src/services/supervisor/`）：期望（specs）↔ 观测（进程快照 + HTTP 健康探测）对账循环（10s + 事件唤醒）；账本 `services-registry.json`；孤儿清杀基于 Job Object 成员判定（2026-11-12 柔性数组 bug 已修）。
- **cap.pluginServiceManager**：`start / stop / restart / list_status / stop_for_plugin / autostart / recent_actions / request`；已鉴权 Remote 整域放行。
- **cap.pluginDiscovery**：`discover / install_local / install_package / install_remote / dev_link / uninstall_local / uninstall_with_cleanup / force_uninstall / check_update / apply_update` 等；Remote 仅放行只读 + `install_remote`，卸载/更新写动作 deny。
- **启停联动已存在**：前端 `usePluginServiceSync` 在 enabled 切换时自动拉起/停止该插件全部 autoStart 服务 → **管理面板只需写状态，进程联动自动发生**，无需面板自己管进程。
- **卸载清杀链（uninstall_with_cleanup）**：先 `stop_services_for_plugin`（≤3s 收敛）→ 按 manifest 收集命令（mcpServers/services/engines）→ sysinfo 精准清杀（专用二进制按映像名；node/python 等通用运行时按"命令行含插件目录"匹配防误杀）→ 等 800ms → 5×500ms 重试删目录 → 失败给可读错误（错误 32 = 目录被占用）。core 插件拒卸、dev-link 只摘 junction，均有硬门。
- **端口**：声明端口或动态分配（10000–60000 bind 探测，避开宿主保留端口）；声明端口被占 → `Error` 终态**不自动重试**（`unavailableReason` 有值但无 UI 呈现）。
- 已知缺口：`list_status` 无 pluginId 服务端过滤（客户端自行过滤）；停止均为强杀（无优雅 drain）；卸载不清 `state.json` 的 `pluginStates[id]` 残留；bare `uninstall_local` 仍暴露在 cap 上（AI/插件可绕过清理直接删目录）；polaris-web 独立 bin 未初始化 Job Object（web-only 部署下进程收容降级）。

### 1.3 商城插件：polaris.marketplace v1.5.0（`D:\space\base\Polaris-plugin\plugins\marketplace\`）

- 形态：**纯面板（React esbuild 单 bundle，58KB，余量充足）+ MCP 工具**（search/detail/versions/proxy_fetch）；`enabledByDefault: true`，常驻 ActivityBar（order=90）。
- 已有能力：多源索引（官方双镜像 + 用户自定义源）浏览/搜索/筛选/双维排序、详情 push 页、安装（User/Project，选版本）、检查/应用更新、卸载（confirm + `uninstall_local`）、「检查全部更新」（串行）。
- **未接**：`cap.pluginServiceManager`（零调用）、`plugin.service.status` 事件、pluginStore 启停；详情区有"二期预留：启用/停用、端口管理"注释占位。
- 弱点：卸载用的是**不停服务、不杀进程的 `uninstall_local`**（比设置页的 with_cleanup 弱）；文案硬编码中文；无批量装卸；安装链路未校验索引中的 sha256（宿主侧 0 校验）。

---

## 2. 痛点根因

| 痛点 | 根因 |
|---|---|
| 开关不方便 | 管理入口在设置页深处；开关藏在折叠卡头部；无列表级搜索/筛选/批量 |
| 看不到插件启动的服务 | 数据层完备（store + 实时事件 + cap）但**无 UI 呈现**；`contributes.services` 声明零展示面 |
| 关不掉单个服务 | stop/restart API 有封装无按钮；只能禁用整插件或卸载 |
| 卸载时端口/进程麻烦 | ① 商城面板走 `uninstall_local` 不清进程 → 进程活着 → 目录锁定删不掉；② 设置页走 with_cleanup 但过程黑盒，失败（错误 32）只有一句提示；③ 声明端口被第三方占用时插件启动 Error，无 UI 解释 |
| 批量操作缺失 | 前端无任何批量面；后端 `autostart` 已是"按 map 全量重算期望"的批量原语，但非用户操作 |

> 澄清：**端口占用本身不阻塞卸载**——杀掉插件自己的进程，端口随即释放。真正的麻烦是"进程活着 → 文件句柄/目录锁定 → 删不掉"，以及"重新安装/启动时声明端口被占 → Error 无解释"。另外 MCP server（stdio）与引擎适配器进程是会话级懒加载、无端口，与 supervisor 管理的后台服务是两类，管理 UI 应分开呈现。

---

## 3. 方案比选

### 方案 A：就地改造设置页 PluginTab
宿主代码权限完整、无白名单问题；但"入口深"的根源没解决，且 PluginTab 已 1603 行，继续堆功能违背 AGENTS.md 的功能路由原则（新增面向用户功能一律默认插件实现）。**不推荐作为主方案**。

### 方案 B：商城插件升级为「插件管理中心」（推荐主入口）
- 优势：常驻侧栏一键直达；已有装卸/更新闭环可复用；独立 bundle 不增宿主体积；符合插件化原则；PluginPanelHost 有 per-panel ErrorBoundary 隔离。
- 要补：管理列表视图、服务状态接入（list_status + 事件订阅）、启停开关（状态写入口）、批量、卸载预检。
- 风险：Remote 端卸载/更新被 deny（手机端功能降级）；与设置页职责需划分。

### 方案 C：混合定位（推荐落地形态）
**商城插件 = 日常管理中心**（浏览/安装/更新/卸载/启停/服务查看与关闭/批量）；**设置页 PluginTab = 深度配置与兜底**（configSchema 表单、权限、引擎详情、诊断）。短期 PluginTab 保留全部能力，商城面板先补齐管理面，稳定后再考虑设置页瘦身。

---

## 4. 核心设计要点

### 4.1 信息架构（商城面板内）
- 顶部工具栏：搜索 + 状态筛选（全部/已启用/已停用/运行中/有错误）+ 批量操作栏（全选、批量启用/禁用/卸载/检查更新）。
- **已装插件一等列表**（替代现在的"已装筛选 chip"）：每行 = 图标 + 名称 + 版本 + 来源徽标（User/Project/Built-in/DEV）+ 运行状态徽标（运行中 N 服务 / 已停用 / 错误）+ 总开关 + 展开区（服务表、MCP 健康、操作列：更新/卸载）。
- **服务表列**：serviceId / state / port / pid / uptime / restartCount / lastError + stop / restart / start 按钮。
- 商城浏览区（可装/可更新）保留，与管理列表分区或分 tab。
- 状态刷新：挂载时 `list_status` 全量 + 订阅 `plugin.service.status` 增量（`__POLARIS_HOST_LISTEN__`，宿主 main.tsx 已挂）。

### 4.2 服务查看与关闭
- 数据源：`cap.pluginServiceManager:list_status`（全量，按 pluginId 客户端聚合）+ `plugin.service.status` 实时事件。
- 关闭：`stop`（单服务）/ `stop_for_plugin`（整插件）/ `restart`；当前均为强杀语义（可接受现状）。
- 已知坑：热装插件未重新 discover 前，其服务未注册进 supervisor，restart 会报 not registered → 面板需捕获并提示"刷新插件列表（autostart 重扫）或重开应用"。

### 4.3 启停开关与状态写入口（决策已定：2026-11-13）

- **决策：不设白名单，状态口走 cap 整域放行。** 新增 `cap.pluginState`（或并入插件域现有 cap）提供 `get_states / set_states` 动作；权限对齐 `cap.pluginServiceManager` 既有模式——本地/面板源放行，已鉴权 Remote 整域 allow，**不做逐动作白名单**。
- 语义不变：写 `plugins/state.json` 必须经后端保存语义（diff 广播 `plugin.lifecycle` + cap 贡献同步 + `usePluginServiceSync` 服务联动）；不能只改前端 store，否则多端漂移。
- 面板经 `router_dispatch` 调用，**无需改动前端 `HOST_INVOKE_ALLOWLIST`**，面板桥既有安全边界保持不动。
- 影响提示：整域放行后，已鉴权 Remote（手机）可读写全部插件状态并触发服务启停联动——这正是管理中心需要的跨端控制力；cap 总线保留完整 dispatch 审计。

### 4.4 批量操作
- 批量启停：循环 `setPluginEnabled`（每笔都走 save + 联动）；插件量大时可后端加批量动作，或复用 `autostart` 的"按 pluginStates map 全量重算期望"原语。
- 批量卸载：单次聚合确认（列出全部影响：服务/端口/目录）→ 逐项 `uninstall_with_cleanup` → 聚合结果（成功 N / 失败 M + 原因）；core 插件排除；dev-link 只摘链接。
- 批量检查更新：现有串行改有限并发。
- 边界：批量操作统一跳过 core 插件与进行中的项。

### 4.5 卸载安全流程（针对"端口占用"痛点）
1. **预检**：查 list_status 该插件服务（运行中? 端口? pid?）+ 是否 dev-link + 是否 core；面板展示"将停止 N 个服务（端口 …）、终止相关进程、删除目录 …"。
2. **确认**：自定义确认弹窗（替代 confirm），普通/强制/dev 三种文案入 i18n。
3. **执行**：统一走 `uninstall_with_cleanup`（商城面板从 `uninstall_local` 切换）；可选后端增加卸载阶段事件（stopping-services / killing-processes / removing-dir）做分步反馈。
4. **失败降级**：错误 32（目录占用）→ 提示可能仍存活的进程 + 一键 `force_uninstall`（改名兜底 `.polaris-plugin-removed-*`）+ 手动处理指引。
5. **顺手治理**：bare `uninstall_local` 从 cap 收紧或标注仅内部；卸载成功后清理 `state.json` 的 `pluginStates[id]` 残留条目。

---

## 5. 前置决策（需拍板）
1. **状态写入口**：✅ 已定（2026-11-13）——不设白名单，走 cap 整域放行（方案见 §4.3）。
2. **设置页与商城面板职责划分**：深度配置留设置页，还是设置页插件 tab 简化为跳转入口？
3. **Remote（手机）权限**：是否开放卸载/应用更新（当前 deny；开放需逐动作评估，卸载属文件系统变更，建议维持桌面限定或加强确认）。
4. **批量卸载确认形态**：一次聚合确认 vs 逐项确认。

## 6. 风险与边界
- `state.json` 是全局唯一权威：面板直写必须走 save 语义，否则多端状态漂移。
- 停止均为强杀（无 SIGTERM/drain）；对有状态服务可能丢尾数据——现状如此，非本改造引入。
- polaris-web 独立 bin 未初始化 Job Object：web-only 部署下进程收容与孤儿判定降级（已知缺口，非本改造范围，但管理中心在 web 模式下 pid/孤儿信息可靠性略降）。
- Remote 权限：管理中心在手机端将缺卸载/更新能力（策略维持则需明确文案）。
- 双入口并存期一致性：两处消费同一数据源（pluginStore + pluginServiceStore + lifecycle/status 事件），天然一致，无需额外同步。
- 面板 bundle 会增大（当前 58KB，余量大）。

## 7. 工作量与分期（粗估）
- **P0 决策 + 小治理**（小）：状态写入口定型；商城卸载切 `uninstall_with_cleanup`；bare `uninstall_local` 收紧；卸载后清 `state.json` 残留。
- **P1 核心体验**（中-大）：商城面板管理列表重构（Panel.tsx 1441 行建议顺势拆模块）+ 启停开关 + 服务查看/关闭（list_status + 事件订阅 + stop/restart/start 按钮）。
- **P2 效率**（中）：批量启停/卸载/检查更新、搜索筛选排序。
- **P3 顺手治理**（小）：安装 sha256 校验、卸载分步事件、面板文案 i18n、web bin Job 收容（可选）。
- **后端**：基本不动（能力已齐）；可选小项：`list_status` 增加 pluginId 过滤参数、批量动作、卸载阶段事件。

## 8. 验收标准（建议）
- 侧栏一键进入管理中心；不进设置页即可完成：启停任一插件、查看任一插件服务（state/port/pid/uptime/错误）、停掉单个服务、批量启停/卸载。
- 卸载运行中插件：先展示影响（服务/端口/进程）→ 确认 → 自动停服务、杀进程、删目录 → 成功/失败结果明确，失败给可操作指引。
- 手机端：可查看服务状态、启停插件；卸载按权限策略给出明确提示。
- 全程走 cap 总线（鉴权 + 审计），不绕过。
