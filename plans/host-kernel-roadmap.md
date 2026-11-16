# 宿主内核化总路线图（50k 第一版 + 持续迁移/删除）

> 日期：2026-11-16 · 状态：实施中
> 目标：宿主（前端 src/ + Rust src-tauri/src/）收敛为「不可替换的核」，一切具体业务可替换/可删除。
> **50k 只是第一版里程碑**；达成后继续按同一判据推进迁移或删除，直到宿主只剩核。
> 已完成：对话域（chat-desk/history-desk）、terminal、browser、translate、im、model-desk、snippet-desk、storage-desk。

## 基线（2026-11-16 实测）

- 前端 src/ 74,510（测试 10.3k）｜Rust src-tauri/src/ 103,262（测试上界 22.4k）｜合计 177.8k
- 核心判据（任何迁移/删除都用这三问）：
  1. 是否在每事件热路径上同步执行？→ 不能外迁（除非异步旁路可容忍丢失）
  2. 是否依赖与存储同事务的原子性？→ 不能拆出进程
  3. 是否只是读聚合/通知/统计/UI？→ 适合插件

## 宿主最终保留核（目标形态）

- 前端：plugin-system 内核、transport、dialogStorage 引擎壳、Layout 骨架、Common 共享件、i18n、types 协议
- Rust：contracts、cap 总线（精简）、models 协议、session 存储执行体+仲裁、web 壳、lib/state、config/data_root 基础
- 明确不保留：一切具体业务 UI/引擎/流水线

## 波次（先易后难，每波独立 spec + 四门禁 + 真机验收 + push）

| 波 | 内容 | 预计净减 | 风险 |
|---|---|---|---|
| K-F1 | 文件工作台出仓（FileExplorer/Editor/Diff + fileExplorerStore/fileEditorStore）| ~7.5k | 中（前置：tabStore 解耦专项） |
| K-F2 | 会话 chrome 出仓（Session/QuickSwitchPanel/remoteSessionFollower/chatExport/sessionDirectory）| ~4.5k | 中高（前置：useWindowManager 边界） |
| K-R5 | Rust commands/ 旧层清退（薄壳化后删除）| ~5.5k | 低 |
| K-R6 | ai_chat_core 拆分（编排下沉 capability，核心瘦身）| ~2k | 中 |
| K-R3 | ask 域外迁（ask_listener/ask_mcp_server → ask 插件）| ~7.4k | 中 |
| K-R4 | nexus/form/context 流水线域出仓 | ~3.5k | 中 |
| K-R2 | 供应商代理 proxy/ 出仓（模型网关插件/独立进程）| ~5k | 中高 |
| K-R1 | simple-ai 引擎进程化出仓 | ~9k | 高（重写级） |

第一版里程碑：K-F1、K-F2、K-R5、K-R6、K-R3、K-R4 完成后预计 ~130k；
继续 K-R2、K-R1 后预计 ~115k；后续波次（持续迁移/删除）按同一判据滚动立项，
直至宿主前后端合计 ≤50k。

## 每波门禁

tsc 0 错 / vitest 全绿 / lint 不新增 error / cargo check + web-only / grep 断言 / 真机验收 / push。

## 风险登记

- tabStore 跨域共享（K-F1 前置专项）
- useWindowManager 与会话 chrome 耦合（K-F2 前置专项）
- simple-ai 进程化：流式吞吐、MCP 客户端、压缩循环需在进程内重建（K-R1）
- 多 agent 并发写丢码：延续快照差集/小批快提纪律
