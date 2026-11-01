# 003 · 调度器命令上总线（cap.scheduler）spec

> 来源：需求库 needs/003（analyzed，2026-10-31 夜班闭案）。状态：specd，待拍板。
> 所有者：宿主端（src-tauri router/scheduler_capability.rs）+ 前端 schedulerService.ts。

## 目标

把 `commands/scheduler.rs` 迁上 RouterBus 成为 `cap.scheduler`，定时任务/模板/协议文档统一经总线权限门控与审计。对齐 cap.session/cap.git 整域摘除范式。

## 现状（2026-10-31 夜班实测，修正前夜 28 命令的低估）

- **47 个命令**（grep `tauri::command` -A1 实测），簇：任务 CRUD+查询（list/get/create/update/delete/toggle/workspace_breakdown/by_category/by_mode）+ 守护（scheduler_start/stop）+ 运行（run_task/update_run_status）+ 模板 7（含 build_prompt）+ 协议模板 7 + 备份等。
- 前端 `schedulerService.ts` 36 处直连 invoke（snippet 段已迁 cap.prompt_snippet，不动）。
- **插件直连情况已闭案**：sundial **零直连**（自带 RRULE/ICS 引擎与提醒投影，grep 其 mcp/service 无任何 scheduler 引用，无需迁移）；news-curator 经 `news_register_schedule` 透传 `scheduler_create_task`（边界已声明：其封装不动，透传目标改名即可兼容——透传调用点在 news-curator mcp/server.js:332，一行适配）。

## 接口：单 cap.scheduler，action 前缀分组

`task.*`（CRUD+三查询+toggle）、`template.*`（CRUD+toggle+build_prompt）、`protocol.*`（协议模板 7 命令）+ `status`（锁/工作区状态查询）。payload 逐字段透传，业务签名不变。

**不上总线**：`scheduler_start` / `scheduler_stop` / `run_task` / `update_run_status`——守护生命周期与任务执行触发绑 AppHandle/后台线程（Web 端无宿主进程语义），保留在 commands/（needs/003 分析结论 #3）。

## 迁移批次（每批独立可回退，批后跑门槛）

1. **task 组**（CRUD+查询，最大簇）：capability 骨架 + UnifiedSchedulerRepository 依赖搬迁 + 前端 task 段改 dispatch。
2. **template 组**（7 命令含 build_prompt）。
3. **protocol 组**（7 命令）。
4. **Web 通道收口**：web/api/ipc.rs 中调度命令 dispatch 包装改为透传 cap.scheduler（对齐 002 spec 同款）。
5. **旧命令摘除**：scheduler.rs 中已迁移命令删除、lib.rs generate_handler 清理；保留 daemon 生命周期与 run 触发。

每批门槛：`cargo check` + `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` + `pnpm exec tsc --noEmit` + schedulerService 相关 vitest。

## 边界（明确不做）

- 不改调度器内核（cron 解析、任务执行逻辑）、数据格式与持久化路径。
- news-curator 的 `news_register_schedule` 封装层不动（仅其透传目标随命令摘除做一行适配）。
- 不做协议 schema 运行时校验（needs/007 治理）。

## 验收（可执行冒烟）

1. 三门槛全绿（上列）。
2. `grep` 前端旧调度命令直连归零（除保留的 daemon/run 命令）；web/ipc 无独立调度 dispatch。
3. 行为冒烟：创建一条定时任务 → 到期正常触发（可在 dev 宿主把间隔设为分钟级）；模板/协议模板增删改查正常；sundial 提醒投影不受影响；news-curator 注册的定时刊物任务正常。

## 风险

- **47 命令体量大**：严格按批走，一批一 commit，禁止一次全量改（并行会话 git 协议纪律）。
- 协议模板组与「协议文档」 UI 耦合深，实施时若发现批 3 体量超预期可再拆 A/B 两批。
