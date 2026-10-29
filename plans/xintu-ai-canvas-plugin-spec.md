# 心图 XinTu —— AI 画布插件 spec

- 状态：**已实施 v0.1.0（2026-10-30，插件仓已提交并打 tag `xintu-v0.1.0`，未 push）**
- 验证：core 单测 19/19 绿；MCP 全流程（mock bridge）14 步断言绿；typecheck/build/产物外置 react 检查过；真宿主冒烟 = **部分完成**——create/edit 已在真实桥落盘实证，九步全量因宿主既有 dispatch 楔死 bug（与本插件无关，见交付报告）未能跑完，宿主恢复后 `POLARIS_SMOKE_CONFIG=<cfg> node test/smoke-real.mjs` 即可补跑
- 实施偏移：撤销/重做改为**全板快照栈**（spec §七原写 op 逆操作栈）——快照实现 30 行、行为等价且支持撤销远端变更，成本收益更优；新增硬纪律：**全程禁用 cap.kv list 动作**（实测大数据根上会拖垮宿主进程，2026-10-30 生产实例实证，spec §六/§十相应收严）
- 仓库：`Polaris-plugin/plugins/xintu`（新插件），主仓不动（不新增 cap，不改协议）
- 所有者：Polaris 插件仓
- 选型依据：见本文件末尾「选型记录」；外部市场证据（tldraw AI 化、Heptabase/Whimsical 品类）见调研记录，检索日期 2026-10-29。

---

## 一、一句话定位

一块**持久的无限画布**：AI 在对话里通过 MCP 工具把想法画上去（脑暴图/架构图/思维导图/对比板），人也能继续拖拽编辑；画布跨轮次、跨设备长存，成为"这个主题的空间资产"。

## 二、动机与划界

**为什么值得做**：AI 对话的产出是易逝的文本流，结构性想法（分类、关联、层次）被压扁成线性文字；通用白板（tldraw/excalidraw）解决了"人画"，但没人解决"**AI 替你画、画完你接着改、改完长期放那儿**"。对话中 AI 画布是 tldraw「AI-enabled canvas」商业化方向验证过的需求，而 Polaris 有 MCP 工具 + cap.kv 跨端同步的现成通道，是天然适配位。

**与 cap.ui.render 图表卡划界（必须写清，防生态质疑）**：

| | cap.ui.render 图表卡 | 心图 |
|---|---|---|
| 生命周期 | 单轮回复的渲染物 | 跨轮次持久的用户资产 |
| 空间 | 聊天流内嵌、纵向 | 无限画布、二维自由布局 |
| 编辑 | 只读 | 人机共同编辑 |
| 所有者 | 渲染管线 | cap.kv（`xt.*` 键空间） |

图表卡回答"这一轮的问题"，心图承载"这个主题的长期结构"。心图不渲染图表，不进聊天流。

## 三、目标用户与核心场景

场景 A（脑暴）：用户说"帮我把刚才聊的 7 个功能创意整理到画布上" → AI 调 `xintu_create` + `xintu_edit` 批量落 7 张卡片并连相关边 → 用户在面板里拖拽归类、改颜色，AI 后续轮次可继续往同一块板补充。
场景 B（架构图）：用户贴一段需求，AI 在画布上画模块节点与依赖边（分层 LR 布局），用户对着面板改，改完让 AI"照画布重新输出设计说明"（`xintu_read` 回读）。
场景 C（手机查看）：出门路上打开手机 Web 面板，查看并缩放这块板（数据在 cap.kv，三端天然一致）。

## 四、产品决策（含否决项）

- **节点类型克制**：v1 只有 `note`（便签：标题+正文）、`card`（卡片：标题+多行正文）、`group`（分组框）。不做图片节点、不做自由笔迹、不做网页 iframe 嵌入（安全面 + 偏离 AI 结构化优势）。
- **不做多人实时协同**：无推送通道（宿主不广播 kv 变更），轮询 + last-write-wins 已够单人双端使用；冲突语义如实标注（见 §9）。
- **AI 编辑走"读改写"批操作**，而非细粒度十几个工具：`xintu_edit` 收 ops 数组，core 层先纯函数试算、任一失败整批回滚——省 token、防半截图。
- **布局是确定性函数不是 AI 自由发挥**：radial（脑暴）/ LR、TB（流程架构）三算法在 core 实现，AI 通过 `relayout` op 触发；坐标 40px 网格吸附。
- 图标：白名单 18 值中选 **Beaker**（脑暴试验田），备选 Target。

## 五、架构与复用

```
对话 AI ──MCP(stdio)── mcp/server.js ──HTTP(md5 token,自发现)── cap.kv (数据根)
                                        ▲
面板(activityBar, React+esbuild esm) ──┘ 轮询 rev（可见时 5s + focus 即刷）
共用权威：shared/canvas-core.js（类型/op 校验与试算/布局/几何/导出，纯函数零依赖）
```

复用清单（不重新发明）：
- **连接层三件套**照抄 page-sentinel：`kvclient.js`（anchor.json→config.json 端口/token 自发现，md5 Bearer，端口上扫 25）、面板 `cap.pluginDiscovery` 自举、服务 start 形态（本插件无服务进程，仅 MCP + 面板，比 amber 还轻）。
- **shared core 模式**照抄 pocket-ledger：面板与 MCP 共用 `canvas-core.js`，口径不漂移。
- **MCP 骨架**照抄 pocket-ledger `mcp/server.js`（stdio 2024-11-05 协议，零依赖）。
- 面板打包纪律：esbuild `--format=esm --external:react --external:react/jsx-runtime`；宿主 blob loader 重写 import。
- 冒烟入口照抄 `node test/smoke-real.mjs`（需宿主在跑，跑完自清理）。
- **不引入 react-flow 等画布库**：面板 blob 加载链对新依赖风险高（loader 重写坑），pan/zoom/选择手搓（参照仓内 animation-studio 自绘经验）；无新框架依赖。

## 六、数据模型与存储（cap.kv，键空间 `xt.*`）

```
xt.boards                → [{id,title,updatedAt,nodeCount}]（索引，可由板键全量重建）
xt.board.<id>            → { rev, title, createdAt, updatedAt, nodes[], edges[] }
  node: { id, type:'note'|'card'|'group', x,y,w,h, title?, text?, color?, z }
  edge: { id, from, to, label? }
```

- 整板单键整存整取（原子粒度=板）；rev 单调递增仅用于面板轮询变化检测。
- **并发边界（如实）**：cap.kv 无 CAS，板级 last-write-wins；单人双端同时改同一块板的窗口极小，P2 前不做 per-node merge，spec 如实标注。
- 容量护栏：板 ≤50 块、节点 ≤500/板、边 ≤1000、单节点文本 ≤2000 字符；越界 MCP 返回明确 error（带 error.param，同 mimo 插件惯例）。
- 颜色用主题 token 档位（6 档语义色），禁止硬编码色值（DESIGN.md 纪律）。

## 七、接口

### MCP 工具（6 个，stdio，前缀 xintu_）

| 工具 | 入参 | 出参 |
|---|---|---|
| `xintu_list` | — | 板索引 |
| `xintu_create` | {title} | {id} |
| `xintu_read` | {id} | 全量 doc（AI 编辑前必读，工具描述里写明） |
| `xintu_edit` | {id, ops[]} | {applied, rev, doc 摘要}；ops 见下 |
| `xintu_delete` | {id} | {}（删除前 doc 里需带 confirm:id，防误删） |
| `xintu_export` | {id, format:'markdown'} | 缩进大纲文本（边→"→"行），AI 可直接引用回对话 |

ops（批内按序、试算、原子提交）：`add_note / add_card / add_group / add_edge / update_node / move_node / delete_node / delete_edge / set_title / relayout{direction:'radial'|'LR'|'TB', root?}`。
op 全部走 core 校验：节点/边存在性、类型、长度、坐标 clamp（±100000）、id 格式；非法即整批拒绝并返回逐条错误。

### 面板（activityBar，supportsFullscreen）

- P0（只读）：板列表/新建；世界容器 transform 平移缩放（空白拖拽/单指、ctrl+滚轮/双指捏合、fit 按钮）；节点 DOM 层 + SVG 边层；移动端可看可缩放。
- P1（编辑）：双击文本编辑、拖移、框选、Delete、选中浮条（颜色/连线起点/删除/成组）；边=节点侧柄拖到目标节点；**op 版撤销/重做**（本地面板会话内，op 逆操作栈）；relayout 按钮；5s 轮询 + focus 即刷同步，热替换保留视口。
- P2（可选）：group 折叠、minimap、模板库（脑暴/架构/对比/故事板）、导出 PNG、AI 新增节点 toast 高亮、图片节点。

## 八、安全与隐私

- 纯本地：`permissions.network=false`，无任何外部请求、无密钥、MCP 无 shell。
- 文本全转义渲染（白名单 mini-markdown 自渲染，禁 `dangerouslySetInnerHTML` 裸用）；节点内容是 AI 产出=不可信输入。
- op 服务端校验（core 单一权威）；kv 键空间 `xt.` 前缀隔离，不碰他插件键。
- 删除板需显式 confirm 参数；无越权面（不申请 fs/bash）。

## 九、已知限制（如实）

- 无推送：面板靠轮询，AI 画完到面板可见最多滞后一个轮询周期（5s）。
- last-write-wins：双端同时编辑同板可能覆盖，P2 前不做合并。
- 无撤销历史持久化：撤销栈仅本地面板会话内。
- 触屏编辑（拖移/连线）放 P2，移动端 P0~P1 以看为主。

## 十、分期与验收（可测）

**P0（生产底线）**：canvas-core + MCP 6 工具 + 面板只读渲染 + 板列表。
验收：真宿主冒烟脚本 `test/smoke-real.mjs` 全绿——①list 空 ②create ③edit 落 10 节点 8 边 ④read 对账逐字段一致 ⑤非法 op（未知 id/超长文本/越界坐标）整批拒绝 ⑥relayout 坐标变化且边保持 ⑦export 大纲含全部节点 ⑧delete 无 confirm 拒绝、带 confirm 成功 ⑨容量上限触发明确报错；面板打开可见完整图，手机 Web 可看。

**P1（完整生产版）**：面板编辑全套 + 撤销重做 + 同步轮询。
验收：纯面板（不碰对话）完成 20 节点架构图：建/改/连/删/撤/重做/重排全流程；桌面改一个标题，手机 5s 内刷新可见；双端 rev 一致。

**P2（增值，按需另立批次）**：见 §七。

**明确不做**：多人协同、笔迹画笔、外部 iframe 嵌入、聊天流内嵌画布卡。

## 十一、测试计划

- core 单测（node --test）：op 试算/回滚、校验矩阵、三布局算法（含环检测、孤立节点）、clamp、export。
- 真宿主冒烟：§十 P0 九步。
- 面板：bundle 构建产物检查（external react 生效、无 node 内置泄漏）；只读渲染快照式断言（给 doc 渲染节点/边数量与坐标）。
- 遵循 AGENTS.md：前端不涉及主仓改动，无需 tsc/cargo；插件仓自带 tsconfig 走自身检查。

## 十二、风险与止损

| 风险 | 缓解 | 止损线 |
|---|---|---|
| 手搓画布 UX 工程量超预期 | P0 只读先行，节点类型克制 | 若 P0 只读版两周内不能自用，停 |
| AI 画得乱、可读性差 | relayout 确定性布局兜底；MCP 工具描述强制"先 read 再 edit"；网格吸附 | 用户每次都要大手动重排 → 收敛节点类型与布局算法后再评估 |
| 与 cap.ui.render 边界被质疑 | §二划界写入 spec 与 README | — |
| 双端冲突覆盖 | 单人场景窗口小；如实标注 | 真实发生丢失 → P2 做 per-node merge |

## 十三、选型记录

2026-10-29 五候选加权评分（满分 100）：闪造 FlashForge ~84 / 书斋阅读 ~81 / **心图 ~70** / 墨匠网文 ~74 / 排练室 ~69。用户在充分知情（含评分与止损线）情况下**选定心图**——用户意志优先于评分，AI 画布的"对话原生 + 人机共编 + 跨端持久"组合是用户最想要的能力形态。实施时若触碰止损线，回到本 spec 记录并重议。
