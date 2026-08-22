# 配置系统重构 — 最终方案(生产级)

> 自主攻坚产出。基于 20 轮分析 + 20 轮验证 + 20 轮痛点搜索。
> 原则:**功能不变,简化扩展升级**。砍掉过度设计,落到具体改动。
> 状态:**全部实施完成,编译+测试全绿**。

## 一、总原则

1. **后端 config.json 是唯一真相源**(A 类跨设备配置)。configStore 不引入 persist(正确设计)。
2. **localStorage 仅存本机 UI 偏好**(B 类),字段名禁与 A 类重叠。
3. **插件配置一等公民**(C 类),manifest 声明 configSchema,复用 config.json 命名空间 `plugins`。
4. **不引入注册表/SyncBus/独立插件配置文件**(砍掉过度设计),用 `applyConfig()` 函数 + 事件机制解决。

## 二、改动清单(7 项,按依赖序)

### 改动 1:提取 applyConfig(config) 统一入口
**问题**: loadConfig 有 7 项副作用,updateConfig/updateConfigPatch 只复现 3 项,新增配置易漏。
**改动**: configStore.ts 提取 `applyConfig(config: Config)` 函数,loadConfig/updateConfig/updateConfigPatch/submitToken 四处调用。
**内容**:
```typescript
// configStore.ts
async function applyConfig(config: Config) {
  if (config.language) i18n.changeLanguage(config.language)
  if (config.spidermanTheme) saveLegacySpiderManConfig(config.spidermanTheme)
  if (config.activeThemeId) {
    useThemeStore.getState().applyThemeById(config.activeThemeId)
  } else if (config.theme) {
    const builtIn = getBuiltInThemeByShortName(config.theme)
    if (builtIn) useThemeStore.getState().applyThemeById(builtIn.id)
  }
  if (config.modelProfiles?.length) {
    const { useModelProfileStore } = await import('./modelProfileStore')
    const store = useModelProfileStore.getState()
    store.setProfiles(config.modelProfiles)
    if (config.activeModelProfileId) store.setActiveProfileId(config.activeModelProfileId)
  }
  if (config.activeModelProfileId) {
    const { useSessionConfig } = await import('./sessionConfigStore')
    const s = useSessionConfig.getState()
    if (!s.config.modelProfileId) s.setModelProfileId(config.activeModelProfileId)
  }
  if (config.activeProviderGroupId && !config.activeModelProfileId) {
    const { useSessionConfig } = await import('./sessionConfigStore')
    const s = useSessionConfig.getState()
    if (!s.config.modelProfileId) s.setProfileMode('group')
  }
}
```
**验收**: 四处副作用链各变为一行 `await applyConfig(config)`;新增配置项只改 applyConfig。

### 改动 2:sessionConfigStore 双写收敛
**问题**: persist modelProfileId/profileMode/providerGroupId 与 configStore 双写。
**改动**: partialize 仅保留 agent/model/effort/permissionMode(本机会话偏好),移除 modelProfileId/profileMode/providerGroupId(派生自 configStore)。
**内容**:
```typescript
// sessionConfigStore.ts
partialize: (state) => ({
  config: {
    agent: state.config.agent,
    model: state.config.model,
    effort: state.config.effort,
    permissionMode: state.config.permissionMode,
  }
})
```
**风险**: profileMode/modelProfileId 不再 persist,重启后从 configStore.activeModelProfileId 派生。applyConfig 已处理注入。
**验收**: localStorage `polaris-session-config` 不含 modelProfileId/profileMode。

### 改动 3:workspaceStore 双写收敛
**问题**: persist workspaces/currentWorkspaceId/contextWorkspaceIds 与 configStore 双写。
**改动**: persist 仅保留 contextWorkspaceIds(纯本机 UI 态),workspaces/currentWorkspaceId 改派生自 configStore.syncFromServer。
**内容**:
```typescript
// workspaceStore.ts
partialize: (state) => ({
  contextWorkspaceIds: state.contextWorkspaceIds,
  viewingWorkspaceId: state.viewingWorkspaceId,
})
```
**风险**: 重启后 workspaces 从 config.json 加载(syncFromServer 已有此逻辑)。contextWorkspaceIds 是纯 UI 态,保留本机。
**验收**: localStorage `workspace-store` 不含 workspaces/currentWorkspaceId。

### 改动 4:单字段 setter 补回滚
**问题**: set_work_dir/set_claude_cmd/set_engine/set_session_dir 无回滚,save 失败内存与磁盘不一致。
**改动**: config_store.rs 四个 setter 套用 update 的 old_config clone + 失败回滚。
**内容**:
```rust
pub fn set_work_dir(&mut self, path: Option<PathBuf>) -> Result<()> {
    let old = self.config.clone();
    self.config.work_dir = path;
    match self.save() {
        Ok(()) => Ok(()),
        Err(e) => { self.config = old; Err(e) }
    }
}
// set_claude_cmd / set_engine / set_session_dir 同理
```
**验收**: save 失败时内存恢复旧值。

### 改动 5:Web 模式 settings.rs 补引擎刷新
**问题**: handle_update_settings 只 patch,缺 refresh_engine_configs(Tauri 模式有)。
**改动**: settings.rs patch 后补 engine 配置刷新。Web 模式无 app_handle,emit 走 WebSocket 广播或暂缓(评估)。
**内容**:
```rust
pub async fn handle_update_settings(
    State(state): State<Arc<AppState>>,
    Json(patch): Json<serde_json::Value>,
) -> Result<impl IntoResponse, WebError> {
    let next_config = {
        let mut config_store = state.lock_config()?;
        config_store.patch(patch)?
    };
    // 补:刷新引擎配置(与 Tauri 模式对齐)
    refresh_engine_configs(&state, next_config.clone()).await;
    // Web 模式 config-changed 广播:走 WebSocket(若已有通道)或暂缓
    Ok(Json(next_config))
}
```
**风险**: refresh_engine_configs 需从 lib.rs 提取为共享函数(目前是 lib.rs 内的 async fn)。Web 模式 emit 需评估 WebSocket 通道。
**验收**: Web 端改配置后引擎配置刷新。

### 改动 6:插件 configSchema 声明 + config.json 命名空间
**问题**: 15+ 插件声明 appConfigRead/appConfigWrite 但无消费 API;插件无法声明可配置项。
**改动**:
- manifest 类型加 `configSchema?: PluginConfigFieldSchema[]`(纯数据,参照 VSCode contributes.configuration)
- Config 结构加 `plugins: BTreeMap<String, serde_json::Value>` 命名空间
- 设置页 PluginTab 按 configSchema 自动渲染表单,保存走 update_config_patch({ plugins: { [id]: {...} } })
**内容**:
```typescript
// plugin-system/types.ts
export interface PluginConfigFieldSchema {
  key: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'select' | 'path' | 'secret'
  default: string | number | boolean
  options?: Array<{ label: string; value: string | number }>
  multiline?: boolean
  placeholder?: string
  help?: string
  sensitive?: boolean
}
export interface PolarisPluginManifest {
  // ... 现有
  configSchema?: PluginConfigFieldSchema[]
}
```
```rust
// models/config.rs Config 加字段
#[serde(default)]
pub plugins: std::collections::BTreeMap<String, serde_json::Value>,
```
**验收**: 插件声明 configSchema 后,设置页自动出现配置表单,值存 config.json plugins 命名空间。

### 改动 7:插件运行时读取配置(MCP 工具 + TS API)
**问题**: 插件声明了 appConfigRead 权限但无 API 消费。
**改动**:
- 内置 MCP 工具 `polaris_get_plugin_config` / `polaris_set_plugin_config`(后端校验 pluginId 归属 + appConfigRead/Write 权限)
- TS API `getPluginConfig(pluginId)` / `setPluginConfig(pluginId, patch)`(内置/外部插件用)
- sensitive 字段读取时脱敏
**内容**: 见实施阶段。
**验收**: 插件 MCP server 可通过工具读取自己 manifest 声明的 configSchema 字段值。

## 三、不做的(砍掉的过度设计)

| 项 | 原因 |
|---|---|
| 配置注册表(200+字段元数据) | 仅治理 6-8 行手写链,不达注册表门槛(需校验/UI生成/权限横切同时存在) |
| SyncBus 总线 + storeCache | 动态 import 字符串破坏 Vite tree-shaking;治理不存在规模 |
| config-changed 全量广播 | 唯一消费方是 performance,全量 emit 高频写入成本高。维持 { performance },按需扩 |
| 独立 plugin-config.json 文件 | 无消费方,复用 config.json plugins 命名空间即可,过早优化 |
| IntegrationPanel 收敛 | 勘误:已有 sync_instances_to_config 单向写回,非双写 |
| shortcutsStore 迁移 | 勘误:只 persist locale,快捷键走代码常量,无需动 |

## 四、落地顺序(Phase 5)

1. 改动 1(applyConfig)— 无依赖,首先做,消除"新增易丢"机制根因
2. 改动 4(setter 回滚)— 无依赖,小改
3. 改动 2/3(persist 收敛)— 依赖改动 1(applyConfig 接管派生注入)
4. 改动 5(Web settings 补 refresh)— 提取 refresh_engine_configs 为共享函数
5. 改动 6(插件 configSchema)— 独立,可并行
6. 改动 7(插件配置读取)— 依赖改动 6

## 五、测试验收(Phase 6)

- cargo check --lib 全绿
- tsc 全绿
- vitest 全绿
- 新增测试: applyConfig 同步链 / setter 回滚 / plugin configSchema 读写
