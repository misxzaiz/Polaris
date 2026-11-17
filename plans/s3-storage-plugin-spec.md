# S3 存储插件化实施 spec（kernel-5k 方案 S3 落地蓝图）

> 日期：2026-11-17 · 上游：`plans/kernel-5k-all-plugin-architecture.md` S3、`plans/host-20k-migration-plan.md` W5+
> 目标：把 Rust 侧会话存储执行体（session_db / session_state / turn_persist / dialog_index / storage，约 6.2k 行）从宿主核中剥离为 storage 插件，宿主仅保留 `cap.storage` 路由 + anchor 指针记录。
> 纪律：每步可编译、四门禁、真机验收、可回退。

## 1. 现状（2026-11-17 实测）

| 模块 | 行数 | 职能 | 消费方（宿主内） |
|---|---|---|---|
| services/session_db.rs | ~1.1k | SQLite 会话消息库（messages.db） | commands/dialog_storage、commands/session_messages、ai_chat_core/events、router/history_capability |
| services/session_state.rs | 1,761 | 会话状态权威库（state.db） | commands/session_state_commands、ai_chat_core(start/interrupt/continue)、router/session_capability、lib.rs 恢复逻辑 |
| services/turn_persist.rs | 1,401 | 回合持久化 + 启动恢复 | lib.rs、ai_chat_core |
| services/dialog_index.rs | 1,334 | 历史索引（FTS/时间线/标注） | router/history_capability、commands |
| services/storage/（sqlite.rs 等） | 905 | SQLite 连接/迁移底座 | 上述各库共用 |
| **合计** | **~6.2k** | | 消费入口 13 文件 |

前端契约：`cap.history`（history_capability）、`cap.session`（session_capability）+ commands 透传（web/api/ipc.rs 75 分支中的 session 部分）。

## 2. 目标形态

```
宿主核（保留）:
  services/router/storage_capability.rs   ← 新 cap.storage 路由（转发 + 权限 + 审计）
  services/anchor_store.rs                ← 锚点记录：{key → plugin_id, file_path}（jsonl 单写者）
  （删除）session_db/session_state/turn_persist/dialog_index/storage

storage-sqlite 插件（新建，系统插件）:
  接管上述 5 模块全部实现，经 cap.storage register_capability 反向注册 handler。
  数据文件路径经 anchor 传入（messages.db/state.db/... 路径不变 → 零数据迁移）。
```

关键约束：
- **数据文件路径与格式不变**（messages.db/state.db/kv.db 原地），插件只是实现体换位——零数据迁移。
- 启动顺序：宿主先起 bus + anchor → storage-sqlite 插件以「bootstrap 内嵌」方式最先安装启动（对齐 kernel-5k §四 风险对策）。
- 事件面：session_state 的广播（session-index 等）改为插件经 bus 事件通道转发，宿主 EventBroadcaster 订阅转发保持前端契约不变。

## 3. 实施步骤（每步独立提交 + 四门禁）

| 步 | 内容 | 验证 |
|---|---|---|
| S3.1 | ✅ 已完成（2026-11-17，4cb32c98）：`services/router/storage_capability.rs` 落地，dialog.* 8 动作接通宿主 dialog_storage inner（真机 curl 验证 list/read 返回正常）；state/turn/index 命名空间 S3.4 接入。桌面+独立 Web 双装配点注册 | cargo check + web-only + curl 真机 |
| S3.2 | ✅ 已完成（2026-11-17，8f69ab94）：`services/anchor_store.rs`（key→plugin_id+file_path，jsonl 单写者 tmp+rename 原子替换，roundtrip 单测随文件；本机 cargo test --lib 受 Tauri DLL 限制仅 lib check） | cargo check lib |
| S3.3a | ✅ 物理域墙完成（2026-11-17，41ec5ab9）：五库集中 `services/storage_exec/`（含 base/sqlite 底座），services/mod.rs 纯 re-export 旧路径零 diff。插件形态定案（plugin-spec-v2）：不做 wasm/独立进程，Rust 能力经 cap register_capability 反向注册——S3.3b 插件接管时把 storage_exec 整体改挂到插件注册的 handler | cargo check + web-only |
| S3.4 | ✅ 命名空间接入完成（2026-11-17，1ec080d6）：cap.storage 15 动作全部接通宿主现存实现（dialog/state/turn/index），真机冒烟 state.list/index.search 正常。前端切到 cap.storage 的迁移（history_capability/session_capability 改经 bus）待下一批 | 真机 curl |
| S3.5 | ✅ 前端 dialog 链路已切 cap.storage（2026-11-17，1a25b11b）：dialogBackend 8 动作改走 services/storageDispatch.ts（浏览器实测 72 个 dialog 读取正常）；lib.rs 启动恢复（recover_pending_turns/recover_unpaired_running_inner）仍直调实现体（进程内，无需经总线） | 浏览器实测 + vitest 685 |
| S3.6 | 删除宿主 5 模块（-6.2k）；storage-sqlite 以系统插件身份热安装 | 真机：会话读写/历史/压缩/恢复全链 |
| S3.6 | 删除宿主 5 模块（-6.2k）；storage-sqlite 以系统插件身份热安装 | 真机：会话读写/历史/压缩/恢复全链 |

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| 插件未起时 AI 链路读会话失败 | bootstrap 阶段内嵌 storage（编译期内嵌 zip 或内嵌动态库），marketplace 就绪后热替换 |
| 事务原子性跨进程破坏（session_state 与 turn_persist 同事务） | 两库同插件同进程内保持原事务；跨插件调用只走已提交数据 |
| usage_db/audit 依赖 | usage_db 留宿主核（统计面）；插件经 bus 上报 |
| 性能（热路径多一跳 bus） | session 读写本就走 router_dispatch；插件内直连 SQLite，实测对比基线 |

## 5. 预期收益

- Rust 宿主 -6.2k（101.8k → ~95.6k）
- 为 S4（AI 业务插件化）铺路：ai_chat_core 的存储依赖全部改走 cap.storage 后，ai_chat_core/ask/nexus 才能整体出仓
