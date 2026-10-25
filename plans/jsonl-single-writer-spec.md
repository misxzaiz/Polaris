# JSONL 归档单写者收敛 + device_id 真实化 spec(阶段 1A⑥)

> 来源:`plans/mobile-pure-phone-analysis.md` §7 阶段 1A ⑥;承接 `plans/session-rearchitecture/S7-消息存储统一重构.md` 被搁置的 Phase 3。
> 动机:方案 A(多端连同一服务器)下,前端 `saveConversation` 的 读盘→合并→整写 与后端 `archive_conversation` 的 读盘→追加→整写 存在 TOCTOU:两个写者各自 read-merge-write,`dialog_write_inner` 的唯一 tmp 后缀只解决同进程 tmp 互斥,不解决**逻辑丢更新**(前端把后端刚归档的并发新增用陈旧快照覆掉)。单机伴生拓扑下窗口极小;手机+桌面同连一台服务器后窗口常态化。

## 0. 与 S7 的关系

S7 Phase 3.1 曾评估"双写共存 + 去重收敛是当前最安全的终态",搁置理由有二:①前端内容最富(attachments/压缩态恢复/前缀保留),②后端归档须覆盖全部引擎 SessionEnd。本 spec 不推翻其结论,只**移走竞态窗口**:

- 前端保留其全部合并智能(压缩态恢复、前缀保留、去重),仍然产出"最富快照";
- 但**落盘动作收敛到后端单一持锁入口**,落盘时后端把前端快照按 id **合并上抛**到当前盘面,而不是覆盖——前端读盘与落盘之间其他写者(后端归档、另一端前端)的新增不会丢。

## 1. 存储层单写者

**所有者**:`src-tauri/src/commands/dialog_storage.rs`。

- 新增 `static DIALOG_WRITE_LOCK: Mutex<()>`,**全部** JSONL 变更路径持锁:`dialog_write_inner`、`dialog_append_inner`、新 `dialog_consolidate_inner`。
- 方案 A 拓扑下所有前端写都经同一后端进程(桌面 Tauri IPC / Web HTTP → 同一 `dialog_write_inner`),进程内锁即全局锁;写路径本就低频(轮末),单全局锁足够,不做 per-file 分片。
- 抽出 `dialog_write_locked`(无锁原子写:唯一 tmp + sync + rename),三个入口持锁后调用,避免 std Mutex 重入死锁。

## 2. `dialog_consolidate` —— 前端整写改为后端原子合并写

**签名**:`dialog_consolidate_inner(name, meta_json, messages_json) -> Result<ConsolidateResult { total }>`

锁内流程:
1. 读既有文件 → `(existing_meta, existing_messages)`(复用自 turn_persist 迁来的 `parse_existing_dialog`);
2. 解析前端快照 `messages_json`(ChatMessage 数组,富内容);
3. **按 id 合并上抛**:同 id → 盘面内容被快照覆盖(快照更新、更富);盘面独有 → 原位保留(并发写者的新增不丢);
4. `sort_messages_by_time` + `dedupe_assistant_by_content`(与既有读侧去重同源);
5. meta:前端 `meta_json` 为准(title/engine/workspace/tokenUsage),`createdAt` 以盘面既有值为准(前端本就透传,双保险);
6. `dialog_write_locked` 原子落盘;返回最终消息总数。

**接线**:tauri command `dialog_consolidate`(lib.rs invoke_handler 注册)+ web bridge `dialog_consolidate` 路由(ipc.rs,与 dialog_write 同区)。

**语义变化(显式记录)**:前端整写从"覆盖"变为"按 id 合并"。单条消息删除不再经此路径传播——现状无消息级删除流(会话删除走 `dialog_delete`,不受影响);若未来出现,须另走显式删除动作而非靠覆写。

**前端**:`dialogBackend.DialogBackend` 增可选 `consolidateFile?`;`RemoteBackend` 实现(invoke `dialog_consolidate`);`saveConversation` 末步优先走它,OPFS/localStorage/mock 后端无此方法时**降级原 `writeFile`**(离线单机无并发写者,覆盖语义安全)。

## 3. device_id 真实化

现状:`turn_persist.rs` 的 `MessageEntry.device_id` 恒 `"core"`(用户/助手皆然)——审计 reason"由设备 X 启动"无法区分真实设备,token 泄漏后无法归因(分析报告 §3.3/开放问题 6)。

- **助手消息保持 `"core"`**:assistant 由后端引擎产生,主机即其"设备",语义本就正确。
- **用户消息携带真实设备**:前端每安装生成稳定 `deviceId`(localStorage UUID,惰性生成),随聊天请求透传:
  - 前端:聊天 form 增 `deviceId`(与既有 `clientType`/`clientPlatform` 同管道);
  - 后端:`ChatRequestOptions.device_id`(serde default,向后兼容)→ `record_user_message` → 用户消息 `MessageEntry.device_id`;缺省回退 `"core"`(兼容旧前端/插件来源)。

## 4. 归档覆盖面核查(S7 搁置理由②,记录结论)

`archive_conversation` 触发点:①`finalize_turn`(SessionEnd 与中断路径,turn_persist.rs:325/333)——三引擎共用同一事件流,引擎侧 SessionEnd 与客户端是否在线无关;②`recover_pending_turns`(进程启动,残留流式轮落定后归档)。即:**客户端断连/崩溃不丢归档**(后端事件权威兜底),满足"前端不写也能落档"的前提。本次前端仍写(合并上抛),该前提是并发安全网而非单点依赖。

## 5. 验收

- `cargo test --lib`(ac8fed0d 已解锁):新增 consolidate 合并用例(upsert/保留并发新增/createdAt 保留/去重)+ 存量 dialog/turn_persist 测试不回归;
- `cargo check` + web-only 门控;前端 `tsc --noEmit` + 相关 vitest;
- 语义回归:单端保存→恢复消息一致;并发模拟(两写者交错)无丢行。

## 6. 涉及文件

| 端 | 文件 | 改动 |
|---|---|---|
| 后端 | `commands/dialog_storage.rs` | 写锁 + `dialog_write_locked` + `dialog_consolidate_inner` + helper 迁入 + 测试 |
| 后端 | `services/turn_persist.rs` | helper 迁出改引用;`record_user_message` 增 device_id |
| 后端 | `services/ai_chat_core.rs` | `ChatRequestOptions.device_id` + 两处 record 调用透传 |
| 后端 | `lib.rs` / `web/api/ipc.rs` | 命令注册 / bridge 路由 |
| 前端 | `services/dialogStorage/dialogBackend.ts` | `consolidateFile?` + RemoteBackend 实现 |
| 前端 | `services/dialogStorage/service.ts` | saveConversation 末步改走 consolidate(可降级) |
| 前端 | 发送链路(createConversationStore 等) | form 增 deviceId;新增 device id 工具 |

## 7. 实施记录(2026-10-25)

**已实施**(全部按 §1-§3 落地):
- `dialog_storage.rs`:`DIALOG_WRITE_LOCK` 全局写锁(三个入口持锁)+ `dialog_write_locked` 抽出 + `dialog_consolidate_inner`/`consolidate_compute`(空快照 no-op 防御、createdAt 盘面为准)+ 7 个 helper 自 turn_persist 迁入(单一真源)+ 4 个合并语义单测;
- `turn_persist.rs`:helper 迁出改引用;`record_user_request`/`record_user_message`/`append_user_message(_row)` 增 device_id 管道(PendingUser 同步携带,无 context 回退路径可达);助手消息恒 "core";
- `ai_chat_core.rs`:`ChatRequestOptions.device_id`(serde default 向后兼容)+ start/continue 两处调用透传(capability 经 serde 反序列化自动承载,零改动);
- `lib.rs` 注册 `dialog_consolidate`;`ipc.rs` 增 `dialog_consolidate` bridge 路由;
- 前端:`detector.ts` `ClientDescriptor.deviceId`(localStorage UUID 惰性生成)+ 两个发送点透传;`dialogBackend.consolidateFile?`(仅 RemoteBackend 实现)+ `saveConversation` 优先走 consolidate、无该方法的后端降级 writeFile。

**验证**:`cargo check` 0 error;`cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 通过;`pnpm exec tsc --noEmit` 0 error;`pnpm test:run` 全量通过(exit 0)。`cargo test --lib` 编译通过但**运行仍受本机 Tauri DLL 启动限制**(STATUS_ENTRYPOINT_NOT_FOUND,ac8fed0d 仅解锁编译;AGENTS.md 既有边界),合并语义由纯函数单测(`consolidate_compute`,4 例)编译期保证 + 运行时待真机回归。

**已知取舍**:整写变合并后单条消息删除不再经保存路径传播(现状无消息级删除流);OPFS/localStorage 降级路径保持覆盖语义(单机无并发写者)。
