# AI 主动陪伴助手 — Phase 1 集成实施报告

> 日期：2026-08-22
> 阶段：Phase 1 集成（已完成）
> 状态：✅ 112 测试全绿，已挂接到主应用

---

## 1. 交付内容概述

本阶段在 Phase 0 基础工具之上，完成了 AI 主动陪伴助手与 Polaris 主应用的集成：

### 新增文件
```
src/
├── components/Companion/
│   ├── CompanionPanel.tsx          # 主面板（启停开关 + pending 队列 + 历史 + 手动触发）
│   ├── CompanionCard.tsx           # 单条主动内容卡片（标题/正文/证据/动作）
│   ├── contentTypes.tsx            # 7 种内容类型 → 图标 + 标签映射
│   ├── CompanionPanel.test.tsx     # 12 组件测试
│   └── index.ts
├── stores/
│   ├── companionStore.ts           # Zustand store（队列/历史/触发/配置）
│   └── companionStore.test.ts      # 12 store 测试
├── hooks/
│   └── useCompanionInit.ts         # 应用启动初始化 + 30 分钟定时评估轮询
└── plugins/companion/
    └── manifest.ts                 # builtin plugin manifest
```

### 修改文件
- `src/plugin-system/builtinPlugins.ts` — 注册 companion manifest + 面板懒加载入口
- `src/App.tsx` — 引入并调用 `useCompanionInit()`
- `src/stores/index.ts` — 导出 `useCompanionStore`

## 2. 集成架构

```
应用启动 (App.tsx)
    │
    ├─ useCompanionInit()
    │     │
    │     ├─ initialize() → 加载 companionConfig
    │     └─ setInterval(30min) → evaluateTrigger()
    │                                   │
    │                                   ├─ decideCompanionTrigger() (疲劳抑制)
    │                                   ├─ generateCompanionContent() (LLM/Mock)
    │                                   ├─ validateContent()
    │                                   └─ 入队 pending
    │
    └─ ActivityBar 自动渲染 Bot 图标（pluginRegistry）
          │
          └─ 点击 → toggleLeftPanel('companion')
                    │
                    └─ LeftPanelContent 兜底:
                       pluginPanelRegistry.has('companion')
                          → <PluginPanelHost panelType="companion" />
                              → 懒加载 CompanionPanel
                                  │
                                  ├─ pending 卡片渲染
                                  ├─ 接受/推迟/忽略按钮
                                  ├─ 历史展开
                                  └─ "试一次"手动触发入口
```

## 3. 关键设计决策

### 3.1 通过 builtin plugin 注册面板入口
- 不修改 `LeftPanelContent`：复用其末尾的 `pluginPanelRegistry.has(type)` 兜底分支
- 不修改 `ActivityBar`：`panelButtons` 自动从 `pluginRegistry.listViewContributions('activityBar')` 拉取
- `enabledByDefault: true` → `DEFAULT_PLUGIN_STATE` 默认 enabled + uiEnabled → 自动可见

### 3.2 状态管理单例 + 注入式依赖
- `useCompanionStore` 是 Zustand 单例，模块级依赖（`_memory`/`_configManager`/`_generator`）可被 `__setCompanionDeps` 替换
- 测试隔离：每个测试 beforeEach 重置依赖 + store 状态，无串扰
- 生产默认：`MockContentGenerator`（Phase 2 替换为真实 engine-registry 调用）

### 3.3 触发评估的"双触发"
1. **定时触发**：`useCompanionInit` 每 30 分钟调用 `evaluateTrigger()`（不强制上下文，由疲劳抑制层决定）
2. **手动触发**：CompanionPanel "试一次" 按钮，注入宽松上下文（用于体验/测试）
3. **事件触发**（Phase 2 接入点）：build 失败 / session 完成 → `recordActivity()` + `evaluateTrigger({ eventSource: 'build_event' })`

### 3.4 与 Polaris 现有面板的同构
- 面板结构（Header / 操作栏 / 内容 / 历史）参考 TodoPanel
- 图标用 `Bot`（已在白名单 `plugin-system/icons.ts`）
- 国际化用 `useTranslation('common')` + `labelKey` + `labelDefault` 模式

## 4. 验证结果

### 4.1 测试
| 测试文件 | 用例数 | 状态 |
|----------|--------|------|
| `companionConfig.test.ts` | 13 | ✅ |
| `companionMemory.test.ts` | 14 | ✅ |
| `companionTrigger.test.ts` | 19 | ✅ |
| `companionPersona.test.ts` | 12 | ✅ |
| `companionContent.test.ts` | 18 | ✅ |
| `companion.integration.test.ts` | 6 | ✅ |
| `companionStore.test.ts` | 12 | ✅ |
| `CompanionPanel.test.tsx` | 12 | ✅ |
| **合计** | **106+6=112** | **✅ 全绿** |

### 4.2 质量门禁
- TypeScript：companion 相关 0 错误
- ESLint：companion 相关 0 错误
- 单元+组件+集成：112/112 通过

### 4.3 UI 测试覆盖
- 面板渲染、开关切换、空状态、禁用状态
- 卡片渲染、接受/推迟/忽略交互
- 清空 pending、手动触发、生成中加载态
- 历史展开收起、已接受标记

## 5. Phase 2 待做（后续）

1. **真实 LLM 接入**：将 `MockContentGenerator` 替换为通过 `engine-registry` 调用真实引擎
2. **事件接入**：
   - Chat 完成 → `recordActivity({ type: 'session' })`
   - Editor 保存 → `recordActivity({ type: 'edit', file })`
   - build 完成 → `recordActivity({ type: 'build', success })` + `evaluateTrigger({ eventSource: 'build_event' })`
3. **成就对接**：`CompanionSkill` 完成 → 触发 `polarisPetStore` 成就
4. **设置面板**：在 SettingsPage 增加 CompanionTab（人格/频率/内容类型编辑）
5. **Toast 联动**：高价值内容（achievement_celebrate）→ toast 提示

## 6. 使用方式

启动 Polaris 后，ActivityBar 会自动出现 **Bot** 图标。
- 点击进入 AI 陪伴面板
- 点击"试一次"立即触发一次主动内容（用于体验）
- 30 分钟自动评估一次（疲劳抑制保证不打扰）
- 接受/推迟/忽略主动内容，历史可回看