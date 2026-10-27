# 磁盘雷达（disk-radar）插件 spec

> 日期：2026-10-28 · 仓库：`D:\space\base\Polaris-plugin`（插件实现）· 本 spec 挂主仓 plans/ 存档
> 一句话：把磁盘变成可对话的空间资产——快照式空间解剖 + 增量「谁偷了我的磁盘」+ 开发垃圾猎手；AI 只读报告，删除永远是人手两步确认。

## 1. 目标与动机

生态缺口盘点（27 个已上架插件）：page-sentinel 盯网页变化、pocket-host 盯本机 CPU/内存/磁盘**余量百分比**、data-ark 做备份——但没有任何插件回答「**空间被谁吃了、最近被谁吃掉的、哪些能安全回收**」。主流工具（WizTree/TreeSize）只有单次静态视图：没有时间维度、没有 AI、没有跨设备。

直接痛点：2026-10-25 的 D 盘清理（记忆 `d-drive-cleanup-2026-10-25`）——主仓 target 32.5G 被并发 dev 会话锁定未删、SVI 疑占 60G 待查。本插件让这类清理变成日常对话。

## 2. 定位与差异化

- **快照增量归因**：每个根目录周期快照（目录树 depth-2 + 总量），两次完整快照间按目录归因增减——「谁偷了我的磁盘」。WizTree 类工具没有时间维度。
- **开发垃圾猎手**：node_modules/target/dist/bin/obj/缓存目录专项清点，**按兄弟文件锚定判定**（`target` 旁必须有 Cargo.toml、`bin/obj` 旁必须有 .sln/.csproj、`node_modules` 旁必须有 package.json）——可解释、低误报；pnpm store 等全局缓存给专用建议。
- **两步删除安全模型**：①移入同卷隔离区 `.DiskRadarTrash`（rename，可恢复）；②确认后彻底删除。AI 工具**全部只读**，没有任何删除类 MCP 工具——AI 报告、人手点击。
- **跨端**：数据全在 cap.kv，手机打开同一面板看到同一份磁盘状态与垃圾清单。

## 3. 架构与跨域决策（三层方案对照 kb/cross-origin）

| 面层 | 方案 |
|---|---|
| 数据面 | 一切状态/快照/清单走 cap.kv（`diskrad.*`），面板/MCP/服务三方共享，跨端一致 |
| 抓取面 | 本插件**零外网请求**：服务（node 原生 fs）本地遍历；面板**零直连 fetch**（宿主 invoke → router_dispatch），无 CORS 面 |
| 桌面加速 | 不依赖 cap.http（Remote 源 deny 陷阱）——面板唯一通道是 invoke+kv，桌面/手机行为一致 |

```
面板/MCP                    服务（唯一写者）
   │ cmd.scan/report/quarantine… │
   ├────────────────────────────▶│ tick 扫到命令键（先删后做）
   │                              │ fs 遍历（预算+可取消）→ 快照/垃圾/隔离结果
   │ 轮询 state/snap/junk/qman    │ 写 cap.kv（diskrad.*）
   │◀────────────────────────────┤
```

## 4. 键空间契约（权威，三方一致）

| 键 | 写者 | 内容 |
|---|---|---|
| `diskrad.settings` | 面板/MCP 写，服务读 | { autoSnapshot, snapshotHours, keepSnapshots, autoBudgetSec, deepBudgetMin, quarantineDays, extraJunkDirs[], excludeNames[] } |
| `diskrad.roots` | 服务写（经 cmd.roots_add/remove 原子改） | { roots: [{ id, path, label, addedAt }] }，id=md5(resolve(path)).slice(0,10) |
| `diskrad.scan` | 服务写（~1.5s 节流） | 当前扫描进度 { id, path, kind, deep, bytes, files, currentPath, startedAt, cancelled? } |
| `diskrad.state` | 服务写（每次扫描后） | { roots: { [rid]: { total, files, lastScanAt, kind, partial, prevTotal, deltaBytes, junkBytes, junkCount, free, volumeTotal } }, updatedAt } |
| `diskrad.snap.<rid>.<seq4>` | 服务写 | { seq, at, kind: auto/manual, deep, partial, total, files, dirs:[{n,b,f,c?,j?,denied?}], junkCount, junkBytes, volume, elapsedMs }（每根保留 keepSnapshots 份） |
| `diskrad.junk.<rid>` | 服务写 | { at, partial, items: [{ id, relPath, name, kind, bytes, files, lastWrite, note? }] }（≤500 条） |
| `diskrad.qman.<rid>` | 服务写 | 隔离区清单 { items: [{ id, relPath, name, kind, bytes, movedAt }] } |
| `diskrad.cmd.<op>.<nonce>` | 面板/MCP 写，服务消费=**先删后做** | op: scan / cancel / report / quarantine / restore / purge / roots_add / roots_remove / settings_set |
| `diskrad.result.<nonce>` | 服务写，请求方读后删 | { ok, at, payload?, error? }（15min 未取由保留清扫删） |
| `diskrad.meta` | 服务写（60s） | 心跳 { version, pid, startedAt, lastTickAt, bridge, scanning } |

## 5. 扫描引擎设计

- 迭代 DFS（显式栈），`readdir(withFileTypes)` + 逐项 `lstat`；**不跟随 symlink**；硬深度上限 40（junction 环兜底）；Windows 旧版系统 junction 名单跳过。
- **预算**：auto 快照 90s、deep 10min、report ≤20s；每 256 项检查预算/取消位；每 512 项 `setImmediate` 让出事件循环（健康端点保活）。超时→`partial: true` 完整落盘。
- **长路径**：≥250 字符自动加 `\\?\` 前缀（UNC 走 `\\?\UNC\`）。
- **无权限/占用**：EACCES/EPERM/EBUSY → `denied` 计数 + 树节点 `denied` 标记（面板显示「?」），绝不中断。
- **垃圾收集搭车**：每次扫描同一次遍历顺带产出垃圾清单——命中规则的目录作为垃圾帧，帧完成时取子树聚合为条目，**帧内不再产生嵌套条目**（防重复计数）；`.DiskRadarTrash` 本身与 `excludeNames` 永不进垃圾/隔离。
- **卷空间**：`fs.statfs` 优先，失败退 `fsutil volume diskfree`（纯函数解析），再失败置 null。
- 快照树记录 depth ≤2、节点预算 4000（超限按 bytes 保 top-64/层）；总量/文件数始终全遍历真实值。
- 单扫描互斥；多根排队串行；auto 快照每根每 `snapshotHours` 一次（补跑只补最近一次）。

## 6. 垃圾识别规则（可解释）

| names | kind | 锚定（兄弟文件须存在其一） |
|---|---|---|
| node_modules | deps 依赖包 | package.json / 各 lock / pnpm-workspace.yaml |
| bower_components | deps | 无 |
| .venv / venv | deps | 无（名即语义） |
| target | build 构建产物 | Cargo.toml / cargo.lock |
| dist / build / out | build | package.json / tsconfig.json / Cargo.toml / pyproject.toml / go.mod |
| bin / obj | build | .csproj / .fsproj / .vbproj / .sln（后缀匹配） |
| .next .nuxt .turbo .parcel-cache .gradle .dart_tool cmake-build-* DerivedData | build | 无 |
| __pycache__ .pytest_cache .mypy_cache .ruff_cache .ipynb_checkpoints | cache 缓存 | 无 |
| .pnpm-store / pnpm-cache | cache | note「包管理器全局缓存——用其 prune 命令更安全」 |
| settings.extraJunkDirs | custom 自定义 | 无 |

## 7. 删除安全模型

- **AI 无删除工具**：disk_* 六工具全部只读；工具描述明示「删除请让用户在面板操作」。
- 隔离：`fs.renameSync(orig, <root>/.DiskRadarTrash/<itemId>)`（同卷原子、快、可恢复）；EBUSY→逐条报「文件被占用，关闭占用进程后重试」（可与口袋主机按端口杀进程联动）。itemId=md5(relPath 小写).slice(0,12)，重扫幂等。
- 路径守卫（纯函数，单测覆盖）：目标必须 resolve 于已登记 root 之下；relPath 禁 `..`/绝对/反斜杠注入；itemId 必须匹配 `^[0-9a-f]{12}$`；purge 只允许删 `.DiskRadarTrash/<id>`，且须 `confirm === true`。
- 恢复：rename 回原位，目标已存在则报错不覆盖。purge：`rmSync(recursive, force, maxRetries)`， freed 记账。
- 移除根目录登记**不删**盘上隔离区（文档写明）。

## 8. MCP 工具（6 个，全只读）

| 工具 | 入参 | 适用句式 |
|---|---|---|
| disk_overview | — | 「磁盘还剩多少」「D盘什么情况」 |
| disk_top | rootPath?, limit=15 | 「什么最占空间」「哪个目录最肥」 |
| disk_growth | rootPath?, limit=15 | 「最近谁涨了」「谁偷了我的磁盘」 |
| disk_junk | rootPath?, limit=30 | 「有什么能删的」「清理开发垃圾」 |
| disk_scan_start | path?, deep=false | 「扫一下 D:\space」「重新扫一遍」 |
| disk_report | path, maxDepth=2, budgetMs | 「看看这个文件夹里面有什么」 |

返回中文结构化文本（列表带 id，面向 AI 续推理）；扫描类即时返回 + 指引用 disk_overview 跟进度；disk_report 内联等待（≤40s）。

## 9. 面板（5 Tab，React 18 + 零第三方库）

- **总览**：根目录卡片（总量大字 / 卷余量条 / 距上次完整快照增量 ▲▼ / 垃圾汇总 / SVG 迷你趋势线），扫描进度条（可取消），空态给 AI 话术引导。
- **空间地图**：squarified 矩形树图（depth-1，SVG，垃圾节点橙色，无权限「?」），点击下钻（cmd.report 实时细查）+ 面包屑 + Top15 列表。
- **垃圾清理**：按 kind 分组小计 + 条目（relPath/大小/文件数/最后写入），逐条与整组「移入隔离区」；隔离区区段（恢复 / 彻底删除 / 清空，双确认）；占用失败如实展示。
- **历史**：快照时间线（总量柱状 SVG + 增量表 + partial 标记），两次完整快照的「空间挪移」归因表（growthDiff）。
- **设置**：根目录管理（增删）、自动快照开关与间隔、预算/保留/隔离天数、额外垃圾目录名、服务管理卡（自发现 start 三步）、数据导出与清空（双确认）、键空间契约简表。

移动端：Tab 横向可滚、40px 触控、操作用点击；`supportsFullscreen: true`。

## 10. plugin.json 要点

id `disk-radar` / name 磁盘雷达 / icon `Files`（白名单）/ order 78 / panelType `diskRadar`；service `disk-radar-service`（http 型，`service/radar.js {{port}} {{appConfigDir}}`，healthCheck `/__health`，autoStart+restart）；MCP `mcp/server.js {{appConfigDir}}`；permissions 仅 `appConfigRead` + `aiToolAccess`（无 network——零外网）。

## 11. 验收（三层，全绿才算完成）

1. **离线单测** `test/run-tests.mjs`（node:assert，零依赖零 mock）：长路径/根规范化/垃圾规则锚定/条目 id 稳定/路径守卫越界样本/squarify 面积守恒与边界/growthDiff 归因/树剪枝/fsutil 解析/fmtBytes。
2. **构建门**：`npm run typecheck`（tsc --noEmit，shared 允许 allowJs）+ `npm run build`（esbuild，React external）。
3. **真实桥冒烟** `test/smoke-real.mjs`：护栏（真实 kv 已有 `diskrad.snap.*` 拒跑）→ 临时目录造树（node_modules/target/普通文件）→ 自发现真实桥 → spawn 真实服务 → roots_add → scan → 快照/垃圾/state 断言 → quarantine→restore→purge 全链路 → spawn 真实 MCP → initialize/tools/list/tools/call 闭环 → finally 杀进程+清光 `diskrad.*`+删临时树，报告 N/N。

## 12. 明确不做（v1 边界）

- 不做重复文件查重（哈希成本高，留给 v2）。
- 不做 SVI/系统目录深查（无权限目录如实计数为 denied，给出「需管理员」提示）。
- 不做自动/定时删除——一切删除人工两步。
- 不做外网任何请求（版本检查也没有）。
- 隔离区跨卷移动（rename EXDEV）不支持——隔离区永远在原卷。
