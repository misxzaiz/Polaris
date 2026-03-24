# 成果索引

## 当前状态
状态: 进行中
进度: 70%

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
- [x] 完成 UI 改造点评估：`TaskEditor` 当前仍只负责 mission/template/userSupplement 等创建参数，编辑既有协议任务时依赖 `task.md` 回填任务目标且锁死模板字段，后续应补 `protocol_state` 只读摘要、结构化初始待办/进度配置入口，以及“协议运行时由结构化状态驱动、文档仅作投影”的边界提示，避免继续把文档当成唯一编辑面 (`src/components/Scheduler/TaskEditor.tsx:314`, `src/components/Scheduler/TaskEditor.tsx:432`, `src/components/Scheduler/TaskEditor.tsx:589`)。
- [x] 明确 `SchedulerPanel` 反馈缺口：任务卡片当前只展示通用调度字段和运行状态，日志面板只消费 `TaskLog` 基础摘要，文档查看器现已支持 `memory/tasks.md` 与 `memory/runs.md`，但仍未展示协议结构化状态与执行元数据；后续需新增协议任务专属概览区，展示 progress/current_focus/pending_count/supplement_state/backup_warning/last_selected_todo，并在日志详情中呈现 protocol execution metadata，否则 UI 仍需人工打开 Markdown 推断执行闭环 (`src/components/Scheduler/SchedulerPanel.tsx:231`, `src/components/Scheduler/SchedulerPanel.tsx:1889`)。
- [x] 明确 `schedulerStore`/前端数据流改造点：store 当前仅拉取 `ScheduledTask[]` 与 `TaskLog[]`，create/update 时也没有传递或缓存协议结构化状态，runTask 后只做整表刷新；后续应在 `ScheduledTask` 与运行结果中引入 `protocol_state`、`protocol_execution` 等字段，并让 store 支持局部刷新协议状态、补充处理结果和日志元数据，减少 UI 依赖重新读文档与全量 reload (`src/stores/schedulerStore.ts:17`, `src/stores/schedulerStore.ts:122`, `src/stores/schedulerStore.ts:203`, `src/types/scheduler.ts:12`, `src/types/scheduler.ts:218`)。
- [x] 完成 `runsTemplate`（执行轮次模板）功能：后端 Rust 添加 `runs_template` 字段支持，生成 `memory/runs.md` 文件；前端添加 `runsTemplate` 类型字段和渲染支持，内置模板包含默认执行轮次模板。Git 提交：`da54225 feat(scheduler): add protocol memory runs support` 和 `6cc36e9 feat(scheduler): 前端支持 runsTemplate 执行轮次模板`。
- [x] 细化 UI 分阶段落地方案：推荐按“类型与 store 扩展 → 面板反馈 → 编辑器配置入口/文档查看器补齐”推进。第一阶段先在 `ScheduledTask`/`TaskLog`/`RunTaskResult` 增加 `protocol_state`、`protocol_execution`、文档统计等可选字段，并让 `schedulerStore` 从“全量 reload”演进到“执行结果局部合并 + 按需补拉日志”，以最小代价打通结构化数据消费链路；第二阶段在 `SchedulerPanel` 任务卡与日志详情补协议概览区，优先展示只读 progress/current_focus/pending_count/supplement_state/warnings，避免先做可编辑状态导致前后端写入职责混乱；第三阶段再收口 `TaskEditor` 与文档查看器，让编辑器提供结构化初始待办/进度配置和只读运行态摘要，同时保留 `task.md` / `memory/*.md` 作为兼容投影与人工兜底编辑面，确保迁移期间旧任务继续可读可改 (`src/types/scheduler.ts:12`, `src/stores/schedulerStore.ts:122`, `src/components/Scheduler/SchedulerPanel.tsx:231`, `src/components/Scheduler/SchedulerPanel.tsx:1889`, `src/components/Scheduler/TaskEditor.tsx:314`, `src/components/Scheduler/TaskEditor.tsx:432`)。

## 进行中
- [ ] 细化协议结构化字段与前后端契约：明确 `protocol_state` / `protocol_execution` / `RunTaskResult` 最小字段集、兼容旧任务的默认值策略，以及任务列表局部刷新与日志补拉的接口边界。
