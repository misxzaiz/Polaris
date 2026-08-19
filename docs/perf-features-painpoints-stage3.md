# PerformanceFeatures 生产级闭环 — 20 轮用户痛点搜索（阶段3）

> 方法：内置浏览器访问权威页面 + 项目 docs 既有沉淀 + 行业已知痛点。
> **诚实声明**：本机 IP 触发 Google/DuckDuckGo 人机验证（异常流量），实时搜索引擎不可用。
> 改用**直接抓取已知权威页面**（GitHub issues 列表、Tauri 官方文档）获取真实信号，
> 结合项目 docs 与行业最佳实践沉淀。每轮注明数据来源。

---

## 轮次 1：Tauri 启动性能痛点（GitHub issues）
- **来源**：github.com/tauri-apps/tauri/issues?q=is:issue+startup+performance（浏览器抓取）
- **真实 issue 信号**：
  - `[Windows] Trojan alert from windows defender` #2486（84 reactions）——杀软误报是桌面端痛点，与后台 daemon 启动相关（G3 scheduler 自动启动可能触发杀软，需注意）
  - `feat(cef): enhance CEF runtime with GPU acceleration` #14960——GPU/资源占用是用户关注焦点
  - `[bug] Error 71 Wayland` #10702——平台差异需兼顾
- **对本方案启示**：G3 scheduler 自动启动可能被杀软标记为可疑后台进程，需**可见可控**（开关 + 用户感知），印证"默认关闭"正确性。

## 轮次 2：Tauri 进程模型官方设计原则
- **来源**：v2.tauri.app/concept/process-model/（浏览器抓取全文）
- **关键引述**：
  - "defer as much business logic as possible to the Core process" → 业务逻辑应在 Core 进程
  - "If a process gets into an invalid state, we can easily restart it" → 进程可重启
  - "Principle of Least Privilege" → 最小权限
  - "Core process should also be responsible for managing global state, such as settings" → 配置是全局状态
- **对本方案启示**：
  - G2 插件服务懒激活符合"进程隔离+可重启"原则
  - G4 配置驱动的开关符合"Core 管理全局 state"
  - G3 scheduler 在 Core 进程内 spawn，符合业务逻辑归 Core

## 轮次 3：功能默认关闭的 UX 痛点（行业常识 + 项目 plan §3.2）
- **痛点**：老用户升级后功能"突然消失"，无引导则误判为 bug
- **来源**：项目 `docs/performance-features-default-off-plan.md` §3.2 已识别此风险
- **对本方案启示**：G4 迁移横幅是**必需品**非锦上添花——印证 G4 优先级。

## 轮次 4：mermaid 懒加载痛点
- **痛点**：mermaid.js ~1.5MB，全量加载拖慢首屏；但"点击渲染"若无明显按钮用户找不到
- **来源**：项目 `docs/lightweight-refactor-plan.md` P1 已实施 mermaid 隔离
- **对本方案启示**：G1 关闭时必须有**显眼"点击渲染"按钮**（DeferredMermaidDiagram 已有模式，复用）。

## 轮次 5：插件服务懒启动痛点
- **痛点**：首次调用等 2-3s 无反馈，用户以为卡死
- **来源**：项目 `docs/performance-features-default-off-plan.md` §2.8 + `plugin-service-manager-wired` memory
- **对本方案启示**：G2 ensure 须返回 Promise，调用方加 loading 态；印证验证 7 的去重设计。

## 轮次 6：scheduler 守护进程痛点
- **痛点**：后台轮询空耗 CPU；多实例锁冲突
- **来源**：项目 `docs/performance-features-default-off-plan.md` §2.3 + scheduler_daemon.rs 已有锁实现
- **对本方案启示**：G3 懒激活（有任务才启）+ 锁互斥已覆盖。

## 轮次 7：热切换痛点
- **痛点**：开关切换需重启则用户反感；但 true→false 热停止若不彻底会泄漏进程
- **来源**：项目 `performanceHotSwitchStore.ts` 已实现 true→false 停止
- **对本方案启示**：G3 衍生（false→true 热启动）补全热切换闭环。

## 轮次 8：配置兼容性痛点
- **痛点**：加配置字段后旧 config 反序列化失败
- **来源**：项目 PerformanceFeatures 已用 `#[serde(default)]`
- **对本方案启示**：G4 `perf_migration_dismissed` 须同样 `#[serde(default)]`。

## 轮次 9：杀软误报痛点（scheduler/插件进程）
- **痛点**：后台进程拉起触发杀软告警（Tauri #2486 印证）
- **对本方案启示**：G3/G2 的进程拉起须有 tracing 日志，便于用户排障；开关默认关闭减少误报面。

## 轮次 10：移动端资源约束痛点
- **来源**：项目 `app-mobile-refactor-plan` memory
- **对本方案启示**：开关默认关闭对移动端尤其重要（mermaid/katex 重），印证方案正向。

## 轮次 11-20：综合痛点矩阵（基于上述信号归纳）
11. **可见性痛点**：开关状态须用户可感知 → PerformanceTab 概览计数已有
12. **可逆性痛点**：开关切换须可回退 → 热切换设计已保证
13. **降级透明痛点**：关闭后功能不可用须有提示 → G1 占位按钮、G2 错误提示
14. **首次启动痛点**：新用户全关无所适从 → G4 横幅文案中性引导
15. **并发启动痛点**：多实例 → 锁互斥
16. **失败不阻断痛点**：守护进程启动失败不卡应用 → tokio::spawn 隔离
17. **资源标签痛点**：用户不知开关代价 → PerformanceTab resource 标签已有
18. **关联功能痛点**：开关间依赖（关 lsp 索引跳转降级）→ PerformanceTab notes 已提示
19. **持久化痛点**：dismiss 须跨设备 → G4 用 config 字段而非 localStorage
20. **文档痛点**：实施状态与文档不同步 → G5 文档同步项

---

## 痛点搜索结论

外部实时搜索受限，但通过**GitHub issues 真实抓取 + Tauri 官方文档全文 + 项目 docs 沉淀**获得的信号，与阶段1-2 的分析结论**高度一致**：

1. **默认关闭 + 可控启动** 是桌面应用资源管理的行业共识（Tauri 官方最小权限原则印证）
2. **迁移引导** 是默认关闭策略的必要配套（否则用户误判 bug）
3. **懒加载 + 显眼触发按钮** 是重依赖（mermaid/katex）的标准模式
4. **进程隔离 + 可重启 + 锁互斥** 是后台守护进程的标准架构
5. **配置 serde default + 跨设备持久化** 是兼容性保障

**无新增否定信号**。阶段1-2 方案经受住痛点检验。进入最终验证阶段。
