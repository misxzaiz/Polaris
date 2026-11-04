# CodeBuddy 引擎适配修复 spec（2026-11-05）

## 背景

用户通过 codebuddy 插件引擎对话时**整轮事件全部丢失**（前端看不到任何回复）。根因排查见会话分析，两个宿主缺陷 + 一批适配器缺陷。

## 根因

1. **缺陷 A（宿主）**：`plugin_process_engine.rs::parse_event_frame` 的 struct-variant 分支用
   `serde_json::from_value::<AIEvent>(frame)` 直接反序列化内部标记枚举。AIEvent 是
   `#[serde(tag = "type")]`，而各事件结构体又有 `#[serde(rename = "type")] event_type` 字段——
   serde 内部标记反序列化先摘掉 `type` 键 → 结构体必需字段缺失 → 100% 报
   `missing field \`type\``（独立 crate 实证）。波及 thinking / assistant_message /
   session_end / error / context_compacted，**error 帧也被吞** → 失败轮次表现为空转后假成功。
2. **缺陷 B（宿主）**：parse match 表缺 `token` / `session_start` / `cli_init` → 落入 `_ => None`。
3. **适配器缺陷**：interrupt 空操作（孤儿 CLI 带 bypassPermissions 继续跑）、
   permission_mode 被无视硬编码 bypass、prompt 走 argv（32k 上限 + cmd.exe 展开风险）、
   tool_call_end 空工具名、resume_token 采集过宽、CLI 冷启动 ~73s 全程无反馈。

## 改动

### 宿主（Polaris 主仓）

- `plugin_process_engine.rs::parse_event_frame` **全部手工构造**（与 tool_call_*/usage 臂同范式），
  补齐 token / session_start / cli_init / error / context_compacted，兼容 isDelta/is_delta、
  engineId/engine_id 双拼写；session_end reason 映射 SessionEndReason。
- 单测 9 个（含 token/session_start/cli_init/error/reason/双拼写）——首次真正执行
  （`cargo test --lib --no-default-features`，需先修 plugin_service.rs:2414 存量编译错误）。
- `EngineMetadata`/`PluginEngineConfig` 增加 `models: Vec<String>`（引擎声明模型目录），
  6 处 metadata() 构造点补 `models`。
- 前端：`PluginEngineContribution.models` / `EngineMetadata.models` / registry 透传 /
  SessionConfigSelector 引擎声明目录优先分支（首项保留「不设置」= 引擎默认）。

### 适配器（Polaris-plugin 仓 plugins/codebuddy，v0.2.0，95fe01f）

- interrupt 真实现：`taskkill /T /F` 全树终止（宿主 interrupt 后 ~200ms 即强杀适配器，
  spawnSync 保证窗口内完成）；会话结束主动退出，对齐协议「结束后一起退出」。
- stdin 'close'/'end' + 信号兜底树杀，宿主崩溃不留孤儿。
- permission_mode 白名单映射（auto→acceptEdits、dontAsk→bypassPermissions），
  缺省 bypassPermissions（与宿主 DEFAULT_SESSION_CONFIG 一致）。
- prompt 改走 stdin（真 CLI `echo | codebuddy -p` 已验证）。
- session_start 提前到 start_session 即刻发出；cli_init 透传 slash_commands。
- tool_call_end 回填工具名；resume_token 仅从 init/result 帧采集。
- env_overrides 注入子进程（测试通道）。
- **流式增量/回放去重（E2E 实测发现）**：codebuddy CLI 流式增量（thinking_delta/text_delta）
  之后会把最终消息拆成多条 assistant 帧（一条 thinking、一条 text）回放，不去重会导致
  UI 渲染双份内容。策略：增量流出后所有 assistant 回放帧跳过，user（tool_result）帧
  为消息边界重置；非流式路径的重复正文帧按文本去重兜底。
- manifest 声明 `models: [hy4-preview, hy3, deepseek-v4.1-flash]`。

### 模型目录链（端到端）

- manifest `contributes.engines[].models` → Rust `PluginEngineManifestContribution.models`
  （注意：带 deny_unknown_fields，漏改会导致**整个插件 manifest 被拒**）→ 前端
  normalizeEngines 透传（逐字段重建，漏加即丢）→ `register_plugin_engine` →
  `PluginEngineConfig.models` → `EngineMetadata.models` → engineMetadataStore →
  SessionConfigSelector 引擎声明目录优先分支（首项「不设置」= 引擎默认）。

## 数据面变化

- codebuddy 插件源迁入 Polaris-plugin 仓，数据根目录换 junction（`Polaris-dev\plugins\codebuddy`
  → `Polaris-plugin\plugins\codebuddy`），不再有手拷副本漂移。
- 插件 id / 引擎 id 不变（启用状态、Profile 绑定、resume token 映射不受影响）。

## 验收

- [x] 假 CLI 冒烟 5 场景 26 断言全绿（tests/adapter-smoke.mjs：帧契约/权限/树杀无孤儿/回放去重）
- [x] `cargo test --lib --no-default-features plugin_process_engine` 16/16 全绿（9 个新解析单测首次真实执行）
- [x] `cargo check` / `tsc --noEmit` / eslint 无新增错误
- [x] 真宿主 E2E（Playwright 驱动 127.0.0.1:9827）：新建会话选 CodeBuddy → 模型选择器列出
      声明目录 → 发消息流式回复可见（思考块 + 正文 + 用量 3万/20万）→ 长任务中断
      （日志证实适配器窗口内树杀、宿主补杀时进程已清、无孤儿）→ 会话落盘 JSONL
- [ ] MSI 打包（tauri:build:test）供用户安装

## 已知边界

- 商城（CDN）推送未做——外发动作留待用户拍板；本地已 commit。
- hy3 / deepseek-v4.1-flash 两模型来自原 README 记载，未经真跑验证（hy4-preview 已真跑）。
- 宿主 interrupt 仍是「发请求 → 200ms → 强杀适配器」策略，未改；适配器侧已在窗口内完成树杀
  （日志证据：适配器 `CLI 进程树已终止 (interrupt)` 先于宿主 taskkill 的「没有此实例」）。
