# DS-1 日志管道治理：启动期保留清扫 + plugin_engine 逐行热路径降级 + read_logs 尾读

> 多 agent 评审第 2 名方案（13/25 分，spec §八）。2026-11-01 立项实施。
> 证据状态：本文关键行号已于 2026-11-01 在 main@0613aca9 实读核验；实施前仍须逐条重定位（行号会漂移，以语义为准）。
> 关联：plans/perf-max-benefit-plan.md §八（评分与落选理由）、AGENTS.md §六（日志分级）。

---

## 一、结论

生产数据根 `logs/` 实测 **954.6MB / 102 个文件**（占数据根 ~73%），洪水日 `app.log.2026-08-09` 单日 **84,629,376 字节**；洪水源至今仍在代码里：`plugin_engine.rs` stdout 读循环对**每次 read_line Ok** 打 `tracing::info!`（含 200 字符预览）、对**每条无法解析的行**打 `tracing::warn!`（300 字符预览）。`logger.rs` 只有按天轮转、**零保留策略**，仓库内无任何日志清理代码；`read_logs` 用 `read_to_string` **全量载入**当前日志（84MB 日=84MB 内存分配）；`commands/logging.rs` 是孤儿文件（`commands/mod.rs` 未声明、全仓零引用、根本不参与编译）。

本方案四步：启动期保留清扫（config 化、可观测）→ 逐行热路径降级（info→debug、warn→时间窗去重）→ read_logs 尾读 → 孤儿文件移除。预期：一次性回收数据根最大户，并把峰值 84MB/天的持续写入切断回 <20MB/天量级。

---

## 二、背景与证据（全部已实读核验）

1. **洪水源**：`src-tauri/src/ai/engine/plugin_engine.rs` stdout 读循环内——
   - `Ok(n) => { tracing::info!("[PluginEngine:{}] stdout read_line 返回 {} 字节: {:?}", ...) }`（~:849-853，**每次 read_line 一条**，200 字符预览）；
   - `tracing::warn!("[PluginEngine:{}] 无法解析 stdout 行: {}", ...)`（~:871-873，**每条解析失败一行**，300 字符预览）；
   - `Err(e) => { tracing::warn!(... read_line 错误 ...) }`（低频，保留不动）。
2. **零保留**：`src-tauri/src/services/logger.rs` 仅 `rolling::daily(&log_dir, &log_file)`（~:32），文件名经 `crate::services::instance::log_filename()` 按实例区分；全仓 grep `remove_file` 无日志清理实现。
3. **全量读**：`logger.rs` `read_logs`（~:87-101）`std::fs::read_to_string(&log_file)` 后才取尾 N 行。
4. **孤儿**：`src-tauri/src/commands/logging.rs`（2355 字节）——`commands/mod.rs` 无 `pub mod logging`、全仓 `logging::` 零引用（2026-11-01 实测）。
5. **历史实测**（2026-11-01 评审运行实测）：logs/ 954.6MB/102 文件/跨度 4.3 个月，占数据根 73%；app.log.2026-08-09 恰 84,629,376 字节，当日 plugin_engine 模块 184,143 行为最大源。
6. **可复用范式**：sqlite.rs `observe_slow` 的 10s 窗口去重计数（~:151-181）；audit_sink.rs 启动期异步清扫不阻塞启动的先例（~:131 附近）；audit_sink 尾读 O(1) 思路。

---

## 三、目标与非目标

### 目标

1. **启动期保留清扫**：日志目录内按保留策略删除过期/超限的历史日志文件。
   - config.json 新增（serde default，旧配置零改动兼容；**磁盘键为 camelCase**，随 Config 全局 `rename_all="camelCase"` 约定——评审修正，勿写 snake_case）：
     ```json
     "logRetention": { "enabled": true, "maxAgeDays": 14, "maxTotalMb": 500 }
     ```
   - 规则：`enabled=false` 整体跳过；删除「最后修改时间早于 now−max_age_days」的日志文件；再按总量（max_total_mb）从最旧起删到限内；**当日活跃文件永不删**（Windows 文件锁 + 在写）；只匹配本应用日志命名前缀（`instance::log_filename()` 的公共前缀 + rolling 日期后缀形态，实施时确认实际文件名模式），误伤面为零。
   - 删除失败（如被另一实例占用）跳过并计数，不 panic、不阻塞启动。
   - **可观测**：清扫结束落一条 info 汇总（删除数/释放字节/跳过数），不逐条打。
2. **plugin_engine 逐行降级**：read_line Ok 的 per-line `info!` → `debug!`（AGENTS.md §六：debug 高频诊断、生产不落盘）；解析失败的 per-line `warn!` → 10s 窗口去重计数（复用 sqlite.rs observe_slow 模式：首条照发 warn，其后 10s 内合并为计数，窗口结束发一条汇总）；`Err(e)` 分支保留。
3. **read_logs 尾读**：不再 read_to_string 全量——从文件尾读最多 512KB 再取 max_lines 行（保留原签名与返回语义）；文件小于阈值时行为与现在一致。
4. **孤儿移除**：删除 `commands/logging.rs`（实施前再 grep 一次引用确认仍为零；mod.rs 未声明故删除零编译风险）。

### 非目标

- 不改日志格式/轮转机制/前端日志查看 UI；不动审计链（audit_sink 有自己的归档治理）。
- 不做运行期周期清扫（启动一次即可，长驻实例的持续性由降级目标 2 根治写入量）。
- 不清理 audit/ 目录（已有归档机制）、不清理引擎会话目录（DS-2 范畴，未立项）。

---

## 四、实施步骤（预计 4 个文件）

1. `services/logger.rs`：新增纯函数 `plan_retention(files: Vec<(PathBuf, SystemTime, u64)>, now, cfg) -> (to_delete, skipped, bytes_freed)`（**纯函数便于单测**）+ `spawn_retention_sweep(data_root, cfg)`（tokio spawn，遍历日志目录 → plan → 逐个 remove_file（错误计数）→ info 汇总）。挂到 lib.rs 装配处（audit 归档同款非阻塞位置；web-only bin 是否也挂：挂，polaris-web 同样有日志目录）。
2. config 结构体：定位 config 加载处（cap.config 域，`permissions`/`web` 同级），加 `log_retention` 段（serde default 全字段）。
3. `ai/engine/plugin_engine.rs`：两处降级 + observe_slow 式去重（小心：读循环是多引擎并发的，去重状态按 engine_id 放已有 per-engine 状态里或用 Mutex<HashMap>，实施时看现有结构选最贴合的）。
4. `logger.rs` read_logs 尾读 + 删 `commands/logging.rs`。
5. 单测：plan_retention 纯函数 3-4 例（过期删/未过期留/当日活跃文件永不删/超限最旧先删/删除失败跳过）；中文注释写根因与依据（AGENTS.md 原则 5）。

---

## 五、验证方法

```bash
cargo check
cargo check --no-default-features --bin polaris-web --bin polaris-mcp
cargo clippy --lib   # 无新增 warning
cargo test --lib --no-default-features services::logger   # 2026-11-01 已实证 no-default 测试可编译运行（待整体确认）
pnpm typecheck && pnpm lint   # 零前端改动，跑一次确认无回归
```

**手动冒烟（隔离实例）**：隔离 POLARIS_DATA_ROOT，在日志目录手工造文件（Git Bash `touch -d "2026-09-01" <f>` 回填 mtime）：
1. 造 3 个过期文件 + 1 个今日文件 + config `max_age_days: 1` → 起实例 → 过期文件删、今日文件留、日志含一条汇总 info；
2. config `max_total_mb: 1` + 造 2MB 旧文件 → 删；`enabled: false` → 全部保留；
3. 删除计数与字节与实际一致。
（plugin_engine 降级的运行时验证依赖插件 stdout 流量，隔离实例无插件——以单测+编译+代码审查为准，如实记录。）

## 六、风险与回滚

| 风险 | 缓解 |
|---|---|
| 不可逆删除历史日志 | 默认 14 天/500MB 温和；config 可关；只匹配日志前缀；当日文件永不删；汇总 info 留痕；分阶段灰度可先把 max_age_days 调大 |
| 多实例并发清扫互删活跃文件 | 按实例前缀区分 + 删除失败跳过计数 + 当日文件跳过 |
| 去重状态引入锁竞争 | 10s 窗口极低频写，Mutex<HashMap> 足够；实施时若 per-engine 状态已有槽位则直接挂 |
| 回滚 | 单 PR `git revert`；无数据迁移 |

## 七、预期收益

| 项 | 现状 | 改后 |
|---|---|---|
| 数据根 logs/ 占用 | 954.6MB（73%） | 清扫一次回收至 ≤500MB 上限，长期稳定 |
| 洪水日写入 | 84MB/天 | 降级后 <1-20MB/天量级（取决于插件 stdout 量） |
| read_logs 内存 | 全量 read_to_string（84MB 日=84MB 分配） | ≤512KB |
| 诊断能力 | 不变（warn 去重保首条+计数；debug 在需要时开） | 不降级排障能力 |
