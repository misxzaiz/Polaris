# spec：manifest 字段级校验补齐（core-slimdown §6-2）

> 状态：**实施中** · 2026-11-11
> 上游：`plans/core-slimdown-plugin-extraction-plan.md` §6-2、`AGENTS.md` §二.4（行为改动先补 spec）
> 本文只定规则与验收，不改协议字段。

## 1. 目标与边界

- 目标：把宿主单源 `PluginService::validate_manifest_fields` 从只校验 `views` / `mcpServers` 两块，扩到覆盖插件前端外移（B2-1 等）会用到的 `panel` / `services` / `chatCards` / `configSchema` 四块的必填字段与路径安全。
- 不做：不改序列化结构、不改协议字段、不新增贡献点、不放松已有规则；`deny_unknown_fields` 继续由 serde 承担。
- 动机：B2-1 插件会声明 `panel` + `services`（可能还有 chatCards / configSchema），字段错误若拖到运行时才静默失效，安装期无法诊断；§6-2 是 L1 外移前置。

## 2. 现状（2026-11-11 实测）

- `validate_manifest_fields`（`plugin_service.rs:1906-1972`）只覆盖 `views`（1926-1956）与 `mcpServers`（1958-1969）。
- `PluginManifestContributes`（`models/plugin.rs:154-203`）实为 **14 个字段块**（总纲旧口径 2/11 已回填为 2/14）。
- 插件仓 132 个 `plugin.json` 离线实测：`services` 70 条、`type` 全为 `http`、`id`/`command` 无空值；`panel` 132 条、`entry` 仅 `./dist/panel.js` 与 `./dist/panel/panel.js`、无空值；`chatCards` 3 条、`configSchema` 19 条（`type` 为 string / select）。→ 新规则不会误伤存量已发布插件。

## 3. 规则（保守：只拦明显错误，不约束未来可扩展值域）

| 块 | 规则 |
|---|---|
| `panel` | `entry` 非空；必须是相对插件目录的安全路径（以 `./` 开头、不含 `..`、不含盘符/绝对路径/控制字符） |
| `services[i]` | `id` / `command` / `type` 非空 |
| `chatCards[i]` | `id` / `mcpServerId` 非空 |
| `configSchema[i]` | `key` / `label` / `type` 非空 |

- **不校验** `type` 枚举：Rust 侧当前无 `service_type` 消费点、configSchema 实测仅 string/select，留扩展空间，避免把可演进值域钉死。
- 其余 10 块（engines / toolProviders / capabilities / skills / styles / executors / adapters / uiTemplates 等）本批不扩：B2-1 不使用，且各结构字段形态不一，逐块补需独立 spec。

## 4. 验收

- `cargo check` 0 错；`cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 通过。
- 单测覆盖：合规 manifest 零错误；`panel` 空 entry 与 `../` 逃逸、`services` 空 command、`chatCards` 空 id、`configSchema` 空 key 各产出精确诊断。
- 插件仓 `node scripts/validate.js` 保持通过（该脚本只校验索引，与宿主校验互补）。
- 离线对拍：插件仓全量 132 个 `plugin.json` 喂入新规则后零诊断。

## 5. 实施记录（2026-11-11）

- `plugin_service.rs::validate_manifest_fields` 已补四块字段级校验（panel / services / chatCards / configSchema），并新增单测 `validates_l1_extraction_contribution_fields`（合规零诊断 + 四类违规精确诊断 + 空 entry）。
- 离线对拍：按新规则扫描插件仓 **138 个 `plugin.json`**，违规数 **0**，确认不误伤存量已发布插件。
- 本机按 `AGENTS.md` 约定不可跑 `cargo test --lib`（Tauri DLL 启动问题），单测需由 CI 实跑；本地验证以 `cargo check` + web-only 门控为准。

## 6. 遗留（不属本批）

- 前端 `pluginDiscoveryService.ts:582-591` 仍只 normalize 8 块（缺 services / capabilities / skills / configSchema / executors / adapters）。需先确认后端发现结果是否已下发这些块，再独立 spec 补齐，避免协议漂移。
- §6-1 插件级白名单：全局 14 条命令（`main.tsx:35`）尚无插件身份参数，按 manifest `permissions` 裁剪属桥身份设计改动，需独立 spec + 前后端同步。
- §6-3 已于 P1-f 落地（`policy_permission.rs:248-254` 以 `require_auth` Allow 放行整个 `cap.pluginServiceManager`），**不是阻塞项**；`im-integration-extraction-spec.md` D4 旧表述作废。
