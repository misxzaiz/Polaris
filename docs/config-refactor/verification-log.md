# 配置系统重构 — 验证日志(20轮)

对 Phase 1 分析结论做代码级二次确认。

---

## V01-V05 验证(R01-R05 分析结论)

### V01 configStore 副作用链不一致(确认)
- 验证: loadConfig 有 7 项副作用(language/spiderman/theme/modelProfiles/activeModelProfileId/providerGroup/cliInfo),updateConfig 和 updateConfigPatch 只复现 3 项(language/spiderman/theme)。
- 证据: configStore.ts:96-131 loadConfig 有 modelProfiles/sessionConfig/cliInfo 同步;:155-216 updateConfig/updateConfigPatch 无此 3 项。
- 结论: applyConfig 提取可统一三处,消除"load 全量/update 部分"的不一致。**确认成立**。

### V02 sessionConfigStore persist 双写(确认)
- 验证: partialize 全量 config(L123),含 modelProfileId/profileMode/providerGroupId,这些 configStore.loadConfig 会注入(L108-128)。
- 证据: sessionConfigStore.ts:122-123;configStore.ts:108/121。
- 结论: 双写确认。modelProfileId/profileMode 应从 persist 移除,改派生。**确认成立**。

### V03 workspaceStore 双写(确认)
- 验证: persist 'workspace-store'(L316) + 6 处 persistToServer(L89/99/141/181/214 等)。
- 证据: workspaceStore.ts:49 updateConfigPatch;:316 persist。
- 结论: 双写确认。**确认成立**。

### V04 Web 模式 settings.rs 缺 emit/refresh(确认)
- 验证: settings.rs:18-25 仅 config_store.patch,无 emit_config_changed/refresh_engine_configs/cascade。grep emit/refresh/cascade 在 settings.rs 无匹配。
- 证据: settings.rs:22-24;对比 lib.rs:181-183。
- 结论: Web 端改配置后引擎不刷新、不广播。**确认成立**。但注意:Web 端的 config-changed 事件需走 WebSocket 而非 Tauri emit,实施时需评估。

### V05 单字段 setter 无回滚(确认)
- 验证: set_work_dir/set_claude_cmd/set_engine/set_session_dir 均为直接赋值+save,无 old_config clone。
- 证据: config_store.rs:237-252。
- 结论: **确认成立**。

### V06 modelProfileStore 非 persist 但有同步缺口(补充发现)
- 验证: modelProfileStore 无 persist(L57 create 无 persist)。setProfiles 调用方:loadConfig:99 + ModelProviderTab:1734。
- 证据: modelProfileStore.ts:57;configStore.ts:96-99;ModelProviderTab.tsx:1734。
- 结论: 非双写源,但 updateConfigPatch 不同步 modelProfileStore(仅 loadConfig 和 ModelProviderTab 自己同步)。非设置页路径改 modelProfiles 会丢同步。applyConfig 提取后统一处理。**补充成立**。

### V07 IntegrationPanel 非双写(勘误确认)
- 验证: sync_instances_to_config 在 commands/integration.rs:133/148/203/222/237,后端命令层写回 config.json。前端 IntegrationPanel 不直接调 configStore.updateConfigPatch。
- 结论: **之前勘误正确,IntegrationPanel 非双写,不动**。

### V08 shortcutsStore 只 persist locale(勘误确认)
- 验证: partialize: { locale }(L433),快捷键走代码常量。
- 结论: **之前勘误正确,不动**。

### V09 config-changed 事件消费方(确认)
- 验证: 仅 performanceHotSwitchStore:50 消费(Tauri 模式)。Web 模式无消费。
- 证据: grep config-changed 全项目,消费方仅 performanceHotSwitchStore。
- 结论: **确认成立**。维持 { performance } payload 合理,有新消费者再按需扩。

---

## V10-V20 改动后回归验证

### V10 applyConfig 修复 updateConfigPatch 不同步 modelProfileStore(确认)
- 验证: 改动前 updateConfigPatch 不同步 modelProfileStore(grep 返回 0),改动后通过 applyConfig 统一同步。
- 证据: git show HEAD 改动前 0 处;改动后 configStore.ts:179 applyConfig(savedConfig)。
- 结论: **不仅简化,还修复了真实 bug**(非设置页路径改 modelProfiles 会丢同步)。

### V11 插件配置全链路接线(确认)
- 验证: Tauri 命令注册(lib.rs) + Web dispatch(ipc.rs) + 前端 API(pluginConfig.ts) + 模块声明(mod.rs)。
- 证据: lib.rs:1109-1110;ipc.rs:377-378;pluginConfig.ts:28/56;mod.rs:14。
- 结论: **全链路完整**。

### V12 Web settings.rs 补引擎刷新(确认)
- 验证: 改动前 settings.rs 无 refresh_all_configs(0),改动后补上。
- 证据: git show HEAD 0 处;settings.rs:24-26 改动后。
- 结论: **确认修复**。

### V13 sessionConfigStore partialize 收敛(确认)
- 验证: partialize 不含 modelProfileId/profileMode/providerGroupId。
- 证据: sessionConfigStore.ts:127-134。
- 结论: **双写收敛成立**。

### V14 workspaceStore partialize 收敛(确认)
- 验证: partialize 不含 workspaces/currentWorkspaceId。
- 证据: workspaceStore.ts:317-323。
- 结论: **双写收敛成立**。

### V15 setter 回滚(Tauri 命令层)(确认)
- 验证: 4 个 setter 都有 old_config clone + 失败回滚。
- 证据: config_store.rs:set_work_dir/set_claude_cmd/set_engine/set_session_dir。
- 结论: **确认成立**。

### V16 Rust 编译全绿(确认)
- 验证: cargo check --lib 无 error。
- 结论: **全绿**。

### V17 TypeScript 编译无新增错误(确认)
- 验证: 改动文件无新增 TS 错误;configStore 的 saveLegacySpiderManConfig 错误为既存(且从 4 处减为 1 处)。
- 结论: **无回归,且减少了 3 处既存错误**。

### V18 vitest 全绿(确认)
- 验证: config-refactor.test.ts 8 个测试全通过。
- 结论: **全绿**。

### V19 Rust 测试编译全绿(确认)
- 验证: cargo check --lib --tests 无 error。
- 结论: **全绿**(含 setter 回滚测试)。

### V20 既有测试无回归(确认)
- 验证: sessionConfigStore.test.ts 的 1 个失败为既存(改动前就失败,与本次改动无关)。
- 结论: **无新增回归**。
