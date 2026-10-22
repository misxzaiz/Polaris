# 插件通用适配器能力 spec：任何 manifest 方言 = 一个插件

> 状态：待评审
> 日期：2026-10-22
> 前置：`plans/plugin-system-upgrade-phase1-spec.md`（schema 单源 1.1 / 下载链 1.6）、`plans/plugin-system-zcode-compat-and-ai-ops-spec.md`（兼容映射表 2.2 是本能力的第一个消费者）
> 用户目标：支持任意改造 Polaris、最大自由度——适配器本身通用化；ZCode 适配器作为**第一个基于通用能力实现的适配器插件**（发现/翻译 `.zcode-plugin` 布局）。

## 0. 技术选型投票纪要（3 票，冲突与裁决）

**形态投票分裂 1:2**：

| 候选 | 得票 | 核心论点 |
|---|---|---|
| A. Translator Plugin（stdio MCP 工具） | 2 | 改动面最小（复用已生产运行的 McpClient spawn + `{{pluginDir}}` 注水）；每来一个新方言**不改宿主 Rust**；本机无法跑测时解释器（B 方案核心代码）不可执行验证 |
| B. 声明式 Adapter DSL（JSON 映射规则 + 宿主解释器） | 1（ZCode 视角） | ZCode 自己处理第三方目录 = 纯数据 schema 归一化；「自由文本决策」是它明确消灭的反模式；可执行进程翻译器能 mint 任意权限 |

**裁决（统一接口，融合两派）**：
- 传输形态 = **A**（2:1，且 A 骨架可被 fake 注入纯测试，绕开本机 cargo test 限制）。
- B 的数据思想不丢弃：**翻译规则必须声明式**——适配器产出走「方言 → Polaris manifest JSON → 宿主单源 schema 全量校验」，宿主校验链上不存在「信适配器代码」的路径；内置 ZCode 适配器的映射表是**数据文件而非逻辑**（吸收 B 派核心关切：防自由代码 mint 权限）。

**全票一致项**（直接定案）：
1. **宿主独占准入权**：适配器只有「翻译权」。产物必须过与 `install_remote` 相同的完整校验链（冻结版 sha256 + deny_unknown_fields + 白名单），失败即 error 不静默。
2. **首发内置**：ZCode 适配器随宿主发布（解「先装适配器再装插件」两级依赖 + 4 处元数据同步债务制度化），但走与外部适配器**完全相同的接口**——内置只是预注册，不是特权通道。
3. **劫持原生格式 = 永久红线**（方言 `polaris-native` 保留字，built-in 插件不可遮蔽——供应链劫持防线）。
4. **id/panelType 强制前缀命名空间**（`zcode.<name>` / `zc:<id>:<surface>`），封 panelType 全局冲突覆盖的坑。
5. **无适配器时零扰动**：原生扫描结果必须与现状逐字节一致（发现循环插入点不动现有函数签名）。

## 1. 自由度边界表（用户「最大自由度」请求的落点裁决）

| 能力 | 裁决 |
|---|---|
| ① 翻译 manifest 字段 | ✅ 允许（本质） |
| ② 声明新 UI surface 类型 | ⚠️ 受控开放（命名空间化 `dialect:sidePanel` + 只能挂进宿主预供的 3-5 种通用容器，不自绘裸窗口）——阶段 3+ |
| ③ 重定向安装路径 | ⚠️ 相对布局允许（登记进安装记录）；逃逸 DataRoot/绝对路径 = ❌ |
| ④ 声明新权限类型 | ⚠️ 冻结至 cap 粒度化 + Source::Plugin 白名单落地（阶段 2）；必须 `dialect:<cap>` 命名空间映射到宿主 cap |
| ⑤ 劫持/抢占原生格式 | ❌ 永久禁止 |

## 2. 交互设计（用户友好裁决：全票 c = 默认自动 + 高级锁）

- **嗅探 = manifest 级指纹匹配**（必填字段形状/互斥集），零网络、可复现；禁止内容猜测式玄学。
- 确认页角色 = **解释而非选择**：「识别为 ZCode 格式 · 经 zcode-adapter v1.x 翻译 · 映射了哪些字段/新增哪些权限」+ 二级入口「更换适配器」。
- **歧义不解**：多方言命中 → 确认页二选一并展示判定依据；完全不识别 → 显式报错 + 「最接近的是 X」。**绝不静默猜一个装上去**（面板消失类事故的翻版）。
- 高级锁兼服务适配器作者调试（跳过嗅探直接指定）。
- AI 安装路径等同：`install_remote` 返回嗅探结果 + 「即将改变什么」摘要，AI 如实转述（spec II §3.2 变更级确认流的参数展形）。

## 3. 技术契约（宿主侧）

### 3.1 适配器声明（manifest `contributes.adapters[]`）

```jsonc
{
  "id": "adapter.zcode",            // 适配器实例 id（插件命名空间内）
  "tool": "discover",               // 适配器 MCP server 上的工具名（默认 discover）
  "idPrefix": "zcode.",             // 必填，空=拒注册（防越权圈占 polaris.* id）
  "roots": ["${WORKSPACE}/.zcode-plugins"],   // 扫描根，变量注水复用阶段 2.5 同款
  "timeoutMs": 3000                 // 单次翻译预算
}
```

### 3.2 运行协议（one-shot，不进常驻池）

```
discover 动作（宿主编排，capability 层）:
  1. 原生扫描（现有函数，签名/行为零改动）
  2. collect_adapters(...) ← 从原生插件清单摘 contributes.adapters（纯函数）
  3. 对每个 adapter：
     a. root 签名（路径+文件数+max mtime hash）命中缓存 → 跳过调用
     b. 否则 one-shot spawn 适配器 MCP server → tools/call → kill_on_drop（预算内）
     c. 产物 admit_translated: deny_unknown_fields 反序列化 → idPrefix 校验
        → validate_manifest_value（阶段 1.4 拆出的纯子函数，file/adapter 收敛单源）
        → 合入结果 + source={kind:"adapter", adapterId}
  4. 容错三态：正常合并 / 超时→stale 缓存+errors{stale:true} / 熔断（连续 3 失败跳过调用）。
     不可用适配器绝不炸掉整个 discover（errors 通道现成）。
新动作： adapters_list（只读：适配器健康红点） / discover_adapter {id}（强制刷新，调试用）
缓存容：  <config>/plugins/adapter-cache/<id>.json（缓存只加速不做真相，staleReason 落档）
```

### 3.3 准入链（适配器无特权）

未知字段即拒（deny_unknown_fields）、越 `idPrefix` 圈占即拒、id 冲突即 error 不覆盖、icon/area/transport 白名单共用单源校验、翻译失败全量 diagnostic 不静默丢 view。审计每次 admit 落链。

## 4. 实施切片

| # | 切片 | 内容 | 验收 |
|---|---|---|---|
| S1（已实施 ✅ 2026-10-22） | 契约字段 + 采集 + 只读动作 | Rust：`AdapterContribution` 模型 + `adapter_discovery.rs` 纯采集模块（`collect_adapters` + fake 注入单测）+ `adapters_list` 动作；TS：`source.kind+="adapter"` + `adapterId` 透传 + vitest | `cargo check` 两向 / `pnpm typecheck` / vitest（本机可执行） |
| S2（已实施 ✅ 2026-10-22，单测编译通过、本机执行受 DLL 限制标注） | 发现循环合并 | `merge_adapter`（one-shot `McpOnceAdapterTransport` 复用 SimpleAI McpClient + 签名缓存 adapter-cache + 连续 3 次失败熔断 + `admit_translated` 准入链：unknown-field/designed 字段/idPrefix/冲突不覆盖 + **复用宿主单源 `validate_manifest_fields` 深度校验与 `into_discovered` 装配**，未引入第四份手写校验）+ `discover_adapter {adapterId, rootPath}` 强制刷新动作 + `SourceKind::Adapter` 变体（安装目的地=用户级目录，带注释）+ `errors[].stale` 字段（前端 TS 同步 + vitest 镜像） | fake 注入单测 8 个（编译全过、执行被 `STATUS_ENTRYPOINT_NOT_FOUND` DLL 限制阻断）；`cargo check` ✅ / web 两向 ✅ / test profile ✅；discover 快路径零扰动（无适配器=原同步路径） |
| S3（部分 ✅） | ZCode 内置/参考适配器插件 | `Polaris-plugin/plugins/zcode-adapter`（discover/translate 工具 + fixture + smoke.mjs 14 断言全绿 + `contributes.adapters` 声明）；宿主侧冒烟（装 DB 装运行）待 Polaris UI 可用 | smoke.mjs ✅；待宿主 e2e |
| S4 | 交互层 | 确认页解释流 + adapters_list 健康显示 + 高级锁 | 确认页 e2e + AI 路径摘要验证 |
| S5 | 外部通道 | 表达力表 ②/④ 依据阶段 2/3 门控逐步开放 | 逐项评审 |

## 5. 已知边界

- S1 前置依赖最少（只依赖模型字段）；S2/S3 依赖阶段 1.1/1.4（schema 单源、`validate_manifest_value` 拆分）——此前不合并，防「第四份手写校验」。
- 适配器插件自身继承全部插件机制（stage/备份/回滚、必经确认流），翻译 win 不绕过 sha256（阶段 1.6 软启动覆盖它的下载路径）。
- 成熟形态存疑项：`roots` 变量注水依赖宿主 env 注水（阶段 2.5），落地前内置 ZCode 适配器首发配 root 自动探测（同 `.codex-plugin` 双布局先例的扫描范围）。
