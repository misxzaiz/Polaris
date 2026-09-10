# Polaris 重构 · 第二步：存储实现规划

> 状态：规划定稿，待实施（当前：文档 + 可视化 PRD 交互原型）
> 日期：2026-09-10
> 目标目录：`dev/docs/sky/` 记录规划；交互原型 `dev/docs/sky/prototype-storage.html`
> 原则：**先实现新骨架，再一块块替换，不着急**。旧数据不迁移，旧系统照常运行。

---

## 0. 承接第一步

第一步已冻结契约（`src-tauri/src/contracts/`），其中已定义：
- `Storage` trait：`root` / `store(domain, item)` / `load(domain, id)` / `query(domain, q)` / `delete(domain, id)` / `begin()`
- `Transaction` trait：`commit` / `rollback` / `append_audit(domain, entry)`
- `AuditEntry` / `Item` / `Id` / `Query` 类型

本步把 trait 变成真实实现，并**对称替换** Polaris 现有存储（命令层零改动）。

---

## 1. 关键判断：借 sky 骨架，不照抄未完成实现

### 1.1 sky 存储实测（代码级核实）

| sky 存储实现 | 状态 | 证据 |
|---|---|---|
| 按域分库 `stores/<domain>.db` | ✅ 成熟 | `storage_sqlite.rs` 每域一 .db |
| `domain_audit` 内嵌各域 DB（同库同事务天然原子） | ✅ 成熟 | `storage_sqlite.rs` 建表含 domain_audit |
| WAL 模式 | ✅ 成熟 | `pragma journal_mode=WAL` |
| `store/load/delete` | ✅ 成熟 | INSERT OR REPLACE / SELECT / DELETE |
| `query` **全扫描 + filter 忽略** | ⚠️ 骨架 | 只 `SELECT id,data FROM items` + limit 截断 |
| `begin()` **事务空操作** | ⚠️ 骨架 | commit/rollback 返回 Ok(())，无真实 BEGIN/COMMIT |
| `rebuild_fts` 存在但**零调用** | ⚠️ 未接线 | 只有测试调 |
| FTS5 `content='items'` 外部内容表 | ✅ 成熟 | DROP + 全量重建 |

**结论**：sky 存储是**骨架验证**，不是生产级。Polaris 采用它的成熟部分（按域分库/审计内嵌/WAL/可丢弃索引），**补全它缺失的能力**（真实 query 过滤 / 真实事务 / FTS 查询路径）。

### 1.2 Polaris 现有存储实测（代码级核实）

| 存储 | 位置 | 类型 | 模式 |
|---|---|---|---|
| 会话索引 | `<root>/dialogs/index.db` | SQLite + FTS5 trigram | 已有索引，JSONL 真相源 |
| Todo | `<root>/todo/todo.json` | JSON 文件 | **全量读入内存→改→全量写回** |
| 需求 | `<root>/requirements/*.json` | JSON 文件 | 同上 |
| 调度 | `<root>/scheduler/*.json` | JSON 文件 | 同上 |
| 配置 | `<root>/config.json` | JSON | 单一真源（沿用） |

- 三个 unified 仓库：`new(config_dir, workspace)` 按需实例化，无全局单例；公开 API（list/get/create/update/delete）被命令层调用。
- 无并发保护、无索引、无审计（JSON 文件模式），这是替换的动机。

**关键**：仓库接口是命令层→仓库的松耦合。**替换内部实现，命令层零改动，前端零感知。**

---

## 2. 交付清单

### A. 新增 `SqliteStorage`（核心，先做 + 单测）

**文件**：`src-tauri/src/services/storage/sqlite.rs`

```
struct SqliteStorage {
    root_path: PathBuf,
    conns: Mutex<HashMap<String, Mutex<Connection>>>,  // 每域一连接
}

impl Storage for SqliteStorage {
    fn root(&self) -> Result<String, String>;              // 照 sky
    fn store(&self, domain, item) -> Result<Id, String>;   // INSERT OR REPLACE
    fn load(&self, domain, id) -> Result<Item, String>;    // SELECT data
    fn query(&self, domain, q) -> Result<Vec<Item>, String>;
        // ⚠️ 补全：解析 q.filter 的字段做 WHERE，而非全扫描
    fn delete(&self, domain, id) -> Result<(), String>;    // DELETE
    fn begin(&self) -> Result<Box<dyn Transaction>, String>;
        // ⚠️ 补全：真实 SQLite BEGIN IMMEDIATE，commit/rollback 真生效
}

struct SqliteTransaction { conn, domain }                 // 真实事务
impl Transaction for SqliteTransaction {
    fn commit / rollback / append_audit                  // append_audit 在内层事务
}
```

**单测**（关键：验证真实能力，非骨架）：
- store→load roundtrip
- query with filter（验证 WHERE 生效）
- delete 后 load 返回不存在
- begin→append_audit→commit：审计落库
- begin→append_audit→rollback：审计不落库（回滚验证）
- rebuild_fts 后可查（DROP+重建幂等）

### B. 三个 unified 仓库对称替换

保持 `new(config_dir, workspace)` 签名，内部从 JSON 文件切到 `SqliteStorage(domain)`：

| 仓库 | domain | 说明 |
|---|---|---|
| `UnifiedTodoRepository` | `todo` | list/get/create/update/delete 改走 sqlite |
| `UnifiedRequirementRepository` | `requirement` | 同上（含 prototype 文件，见风险） |
| `UnifiedSchedulerRepository` | `scheduler` | 同上 |

公开 API 不变 → 命令层零改动 → 前端零感知。

### C. 会话存储（独立块）

对齐 sky `session.rs`：JSONL 真源 + SQLite 可丢弃索引（Polaris 已有 `dialog_index.rs`，本步评估其是否已满足，不重复造）。

---

## 3. 边界（做/不做）

- ✅ 新增 `SqliteStorage` + 真实 query/事务 + 单测
- ✅ 三个 unified 仓库底层切到 `SqliteStorage`，命令层零改动
- ❌ 不碰 DataRoot/anchor（沿用，已收敛）
- ❌ 不碰会话 JSONL 真相源（保留，改的是索引层）
- ❌ 不碰前端（命令层签名不变）
- ❌ 不迁移旧 JSON 数据（符合"旧数据 AI 处理"决策）

---

## 4. 验收标准

1. `cargo check` 通过
2. `Storage` trait 实现单测通过（真实 query/事务，非骨架）
3. 三个 unified 仓库切换后命令结果回归一致
4. 现有 284 个 command 零改动，应用照常运行

---

## 4.5 落地状态（阶段 A）

**2026-09-11 阶段 A 已完成并验证**（含复审修订，见下）：

- 新增 `src-tauri/src/services/storage/sqlite.rs`（约 700 行）：按域分库 + 内嵌 `domain_audit` 审计表 + 真实 query（`json_extract` WHERE + 字段名白名单防注入）+ 真实事务（`BEGIN IMMEDIATE`，跨域连接统一 commit/rollback，Drop 未 finish 自动回滚）+ FTS5 可丢弃重建索引。
- 连接 PRAGMA 对齐既有惯例（`dialog_index.rs`）：`journal_mode=WAL` + `synchronous=NORMAL` + `busy_timeout=5s`。
- 审计 `source` 落库存变体名（Bootstrap/Remote/Plugin），**不存 token 明文**（脱敏）。
- 挂载：`services/mod.rs` 新增 `pub mod storage;`，`storage/mod.rs` 导出 `SqliteStorage`。
- 单测：同文件 `#[cfg(test)] mod tests` 共 **12** 个场景（store/load roundtrip、filter string/numeric、limit、delete、commit→审计落库、rollback→审计回滚、commit 后二次写审计保留、Drop→自动回滚、FTS 重建、字段名注入拒绝、**审计 source 不存 token**）。
- **Tauri 环境限制**（`cargo test --lib` 无法启动，0xc0000139）：测试经独立 crate `/tmp/storage-verify`（复制 contracts + sqlite.rs，rusqlite 0.32 bundled）实际运行，**12 passed / 0 failed**；主项目 `cargo check --tests` 通过、sqlite.rs 零 warning。

**已知缺口（阶段 B 处理）**：
1. **审计与业务写不同事务**：契约红线「同库同事务天然原子」此处仅达成「同库」——审计写走事务连接，业务写（`store`/`delete`）走连接池 autocommit，两者不同事务。trait 仅暴露 `append_audit`、无事务内业务写方法，结构性受限。阶段 B 接线时评估：给 `Transaction` 增加事务内业务写，或接受「审计自成一个事务」并同步修订契约。
2. **FTS 无查询路径**：`rebuild_fts` 重建索引但无 `Storage` 查询方法触达 FTS，后续做全文检索时补。

**验收 1、2 达成**（`cargo check` 通过、单测真实运行通过）；验收 3、4（切换后回归）属阶段 B。

## 5. 影响面

| 维度 | 影响 | 说明 |
|---|---|---|
| 现有代码 | 🟡 中 | 新增 storage 模块 + 3 个仓库内部改造 |
| 命令层/前端 | 🟢 零改动 | 仓库签名定住，命令层无感知 |
| 数据 | 🟢 不迁移 | 旧 JSON 不迁，新 SQLite 从空开始 |
| 风险 | 🟡 中低 | 仓库接口不变，命令层无感知 |
| 架构 | 🟢 正向 | 统一到 Storage trait，为第三步 dispatch 铺路 |

---

## 6. 实施顺序建议（分步）

- **阶段 A**：`SqliteStorage` + 真实 query/事务 + 单测（**先做，独立验证**）
- **阶段 B**：三个 unified 仓库对称替换（A 验证后）
- **阶段 C**：会话索引评估/对齐（独立块）

不一次全改，A 验证通过再动 B。

---

## 7. 交互原型

见 `dev/docs/sky/prototype-storage.html`：可视化展示 按域分库 / Filter 查询 / 事务与审计 / 仓库替换的交互流程。