# 成果索引

## 当前状态
状态: 进行中
进度: 50%

## 已完成
- [x] 完成首轮现状调研，确认协议任务由 Rust `ProtocolTaskService` 生成目录与模板，执行时由 dispatcher 拼接 `task.md`、`memory/index.md`、`memory/tasks.md`、`user-supplement.md` 形成最终提示词。
- [x] 识别出模板与运行时规则存在双源：前端内置模板使用 800 行备份阈值，而 Rust 默认生成模板仍写死 300 行，并额外注入 `AgentOS 工程决策协议`，导致新建任务文档与当前实际协议不一致。
- [x] 识别出任务编辑与状态管理仍以“单任务文档读写”为核心，缺少对“待办选择、进度推进、补充归档结果”的结构化建模，当前改造更适合先收敛到协议模板统一与执行状态模型统一。
- [x] 完成“三阶段改造方案”落地顺序评估：应先统一协议模板单一数据源，再引入结构化协议状态模型，最后补执行前后读写闭环与 UI 反馈；否则会在双模板与 Markdown 解析并存阶段放大迁移成本。
- [x] 明确阶段风险：阶段一风险最低但需解决前端内置模板与 Rust 默认模板/占位符渲染边界不一致；阶段二是核心风险，涉及 `ScheduledTask`/store/前端编辑器从“文档即状态”迁移到“结构化状态 + 文档投影”；阶段三依赖 dispatcher 把 supplement 归档、memory 读写结果、日志反馈结构化暴露给 UI，否则闭环仍停留在 AI 自维护约定。
- [x] 完成“协议模板单一数据源”三路径对比：当前创建链路已由前端 `TaskEditor` 把所选模板快照直接写入调度参数并交给 Rust `create_task_structure_with_templates`，因此“前端下发模板快照”迁移成本最低，但内置模板仍分散在前端常量与 Rust fallback，编辑已有任务或无模板创建时仍会漂移。
- [x] 明确三种模板统一路径的取舍：1）Rust 持有内置模板可保证创建/执行同源，但前端模板管理器需新增查询接口且自定义模板编辑体验会转成后端驱动；2）前端下发模板快照改动最小，可直接复用 `protocolTemplateStore` 与 `TaskEditor`，但必须彻底移除 Rust 默认模板或把其降级为仅兜底兼容；3）共享模板定义文件最利于长期治理，可把模板 schema 与内置内容沉淀为单文件源，再生成 TS/Rust 产物，但需要引入生成流程与构建约束，不适合作为第一步。
- [x] 给出阶段一推荐顺序：先以“共享模板定义文件 / JSON 资产”为目标态，但首个落地点应是“前端模板快照为唯一运行时输入 + Rust fallback 收敛为读取同一份共享资产或报错”，先消除新增任务漂移，再为后续状态模型统一留出稳定输入边界。
- [x] 完成协议任务状态模型初稿：当前 `ScheduledTask`/前端类型仅保存调度配置与通用执行状态，dispatcher 仍在运行时直接拼接 Markdown，说明“任务进度、当前执行焦点、待办选择结果、补充是否待处理”尚未进入结构化层。
- [x] 明确协议状态拆分建议：`ScheduledTask` 保留稳定配置，新增可选 `protocol_state` 承载 `status/progress/current_focus/completed_items/pending_items/last_selected_todo/supplement_state/document_stats`，由 UI 与 dispatcher 共用，Markdown 降级为展示投影而非唯一事实来源。
- [x] 明确运行结果拆分建议：在 `TaskLog`/运行结果中补充协议执行元数据，如 `selected_todo`、`supplement_handled`、`memory_updated`、`backups_created`、`protocol_state_changed`、`warnings`，这样执行闭环与 UI 反馈可直接消费结构化结果，不必再反向解析文档差异。
- [x] 确认迁移边界：第一步不要求移除 Markdown，而是让 Rust 在执行前读取结构化协议状态并生成文档投影；执行后优先更新结构化状态，再按需回写 `memory/index.md` 与 `memory/tasks.md`，从而把现有 `schedulerStore`/`TaskEditor`/日志体系改造成“结构化状态主导、文档兼容展示”。
- [x] 完成执行闭环设计：当前 dispatcher 仅在构建提示词时直接读取 `task.md`/`memory`/`supplement`，执行成功后只会归档并清空 supplement，未把“补充是否处理成功、memory 是否回写、备份是否触发、待办是否推进”沉淀到结构化状态或日志，导致闭环结果对 UI 不可见。
- [x] 明确执行闭环职责拆分：执行前由 scheduler 基于 `protocol_state` 生成本轮输入快照（含 selected todo、supplement 摘要、文档统计）；执行后解析/接收本轮结果，统一更新 `protocol_state`、回写 `memory/index.md` 与 `memory/tasks.md` 投影，并在成功时再归档 supplement，失败时保留补充内容与待办焦点供下轮继续。
- [x] 给出协议执行元数据建议：新增 `ProtocolExecutionSnapshot`/`ProtocolExecutionResult` 一类结构，覆盖 `selected_todo`、`supplement_status`、`memory_updates`、`document_backups`、`progress_delta`、`warnings`；`TaskLog` 只保留摘要字段或引用，详细结果挂在运行结果/事件载荷中供 `schedulerStore` 和日志面板消费。
- [x] 明确落地顺序：先抽出 dispatcher 的“执行前读取 + 执行后补充归档”散落逻辑为统一 protocol runtime service，再补结构化结果写回与日志扩展，最后让 UI 基于 `protocol_state`/执行元数据展示当前焦点、补充处理结果、备份告警和进度推进，避免继续依赖 Markdown 差异推断闭环状态。

## 进行中
- [ ] 评估 UI 改造点：梳理 `TaskEditor`、`SchedulerPanel`、`schedulerStore` 在协议模式下需要新增的配置项与反馈展示。
