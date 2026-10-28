# spec：插件面板打开宿主观测（守望台自动记账的数据源）

> 状态：已实施（2026-10-29）。问题：守望台插件的用量统计只能记到"自己"——
> 宿主不广播其它插件面板事件，"打开其他插件没有记录次数"。本 spec 让宿主
> 在权威观测点把面板打开落账，守望台读宿主观测合并进既有账本。

## 1. 目标与边界

- **目标**：用户打开任何插件面板（外部插件 + 走 PluginPanelHost 的内置插件面板）
  时，宿主自动记一次 `{pluginId, 面板打开}`，守望台面板/MCP 展示时合并。
- **不做**：
  - 不观测核心面板（files/git/browser/todo 等 `builtinPanels` 表直渲染，非插件运营对象）。
  - 不观测"AI 调用其它插件 MCP 工具"（工具调用直连插件 MCP 子进程，宿主不在链路；
    该通道维持守望台 `watchtower_report_usage` AI 补记口径）。
  - 宿主不写守望台私有键（`watchtower.usage.*`），只写自有键空间。

## 2. 数据契约（cap.kv，宿主自有键空间）

- `plugin.usage.<pluginId>` → HostUsageObservation：
  `{ v: 1, pluginId, count, firstUsed, lastUsed, days: { 'YYYY-MM-DD': n } }`
- 写入方**唯一**：宿主前端 `pluginUsageObserver`（read-merge-write，90 天窗口裁剪，
  `count/firstUsed/lastUsed` 累计语义不随 days 裁剪丢失）。
- 面板打开是人工频率（每会话每面板首次挂载记 1 次），read-merge-write 的丢更新
  窗口为毫秒级且只影响"观测量"计数，不引入锁/新能力。
- 经 `router_dispatch → cap.kv` 走统一权限 gate + 审计，无新增 capability。

## 3. 事件流（所有者与时序）

```
用户激活面板
  └─ LeftPanel（懒挂载，首次激活才渲染）
       └─ PluginPanelHost.loadPanel() 成功           ← 权威观测点（每会话一次）
            └─ notePluginPanelOpen(pluginId)          [fire-and-forget，失败静默]
                 ├─ cap.kv get plugin.usage.<id>
                 ├─ merge：count+1 / days[today]+1 / first·last 更新 / 裁剪>90天
                 └─ cap.kv set（唯一写路径）
守望台面板 / watchtower_usage_stats（读时合并，不回写）
  ├─ cap.kv list → watchtower.usage.* + plugin.usage.*
  ├─ mergeHostIntoUsage(rec, obs)：panel 通道 += 观测（trends[day].panel、panelOpens）
  └─ 展示 / 冷热分级 / 治理建议（usage-core 单一权威）
```

- **幂等**：React StrictMode 双挂载用 ref 守卫；观测每会话每面板记 1 次
  （面板保活常驻，切换显隐不重挂不重记）。
- **归属**：面板打开 = 宿主观测（source=panel 通道）；守望台自身面板打开
  **停止自记**（改由宿主观测，消除同事实双写者）；MCP 通道仍由守望台自记。

## 4. 验收

- [ ] 打开任意外部插件面板后，`cap.kv` 出现/递增 `plugin.usage.<pluginId>`。
- [ ] 守望台面板"活跃榜/冷门榜"把该插件计为活跃（面板通道），末次时间正确。
- [ ] `watchtower_usage_stats` 输出与面板口径一致（usage-core 同源）。
- [ ] 宿主 `pnpm typecheck`/`lint` 通过；观察者失败不影响面板加载。
- [ ] usage-core 单测含合并幂等语义（同基账 + 同观测多次重放结果确定）与
      时间无关性（注入 now）；mcp-verify 无宿主场景与真实宿主隔离。
