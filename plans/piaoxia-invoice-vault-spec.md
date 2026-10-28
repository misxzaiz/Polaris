# 票匣（piaoxia）—— 个人电子发票保险库 插件 spec

> 状态：已定案，实施于 Polaris-plugin 仓 `plugins/piaoxia/`。
> 定位：把散落在下载文件夹 / 微信卡包导出 / 邮箱附件里的**电子发票文件**，收拢成一本可对话、可判重、可跟踪报销状态、可支撑保修维权的本地票账。

## 一、为什么做（市场证据摘要）

- **痛点实证**：企业费控 SaaS（易快报、泛微发票通、每刻）把「发票散落在个人邮箱/微信卡包/桌面、重复报销风险、归集难」作为核心卖点（2025 年厂商博客与方案页），说明痛点规模足以养活一个市场；但这些全是**企业侧收费 SaaS**。
- **个人桌面侧有工具但传统**：微软商店「发票盒子 / 智汇盒子 / 小河狸发票助手」证明个人需求真实存在，但都是表单驱动的单机收费工具——无 AI 对话、不与工作台集成、不开源。
- **技术拐点**：数电票 2024-12 全国推广后，20 位发票号码 + 取消特定版式 + 官方 XML 原件成为常态；电子发票 PDF 自带文本层（开源 invoice2excel 等项目已验证 pdfplumber/pdfjs 提取可行），**本地纯解析**成为可能，无需 OCR、无需云 API。
- **Polaris 生态空位**：插件生态已有消费账本（算盘/口袋账本）、订阅账（守闸/常契）、贷款账（泉府）、车账（车匣），但「票据/凭证文档账」为空白；zhifang 已趟平 vendor pdfjs + 本地服务 + 拖拽上传的全部技术件。

## 二、产品定义

- **名称**：票匣（piaoxia）——匣者，收票据也；与车匣、纸坊同韵。
- **一句话**：个人电子发票保险库——拖进来自动解析判重，报销状态一句流转，保修维权随查随有据。
- **目标用户**：① 需要报销的上班族（差旅/采购/餐饮）；② 需要留购买凭证的家庭用户（家电保修、退换维权）。
- **核心场景**：
  1. **收票**：拖拽 PDF/XML 进面板，或对 AI 说「把下载文件夹里的发票收进来」。
  2. **判重**：发票号码（20 位数电票 / 8 位+12 位代码旧票）唯一键，重复导入明确告知已有票据与状态——防财务打回。
  3. **报销流**：待报销 → 已提交（报销单号）→ 已到账 / 已退回；月末「这个月能报多少」「哪些还没报」。
  4. **保修维权**：发票即购买凭证；「空调保修几年」记 warrantyMonths，保修到期倒数；「冰箱坏了」找出发票与销方。
  5. **抬头**：公司/个人开票信息一键复制。
  6. **统计**：按月/类别/销方统计、报销单分组、年度汇总、CSV 导出。

## 三、明确不做（边界）

- **不做 OCR**：纸质票/扫描件无文字层，如实告知并引导手动录入（AI 对话或面板表单）。
- **不做 OFD**：数电票 OFD 版式为 zip 容器，MVP 不支持（提示用 PDF/XML）。
- **不做发票查验**：对接税务查验接口需外部服务与登录态；判重以本地发票号码为准。
- **不做企业审批流 / 多部门**：个人票据账。
- **零外网请求**：全部本地解析与存储。

## 四、架构（zhifang 服务型范式 + wenjin 台账范式）

```
 piaoxia/
 ├── plugin.json / update.json / .pluginignore / README.md
 ├── vendor/pdfjs.min.js + pdf.worker.js     # 复用 zhifang 同款（Node 文本抽取已验证）
 ├── service/
 │   ├── main.js        # HTTP 127.0.0.1:<自动分配端口> + token；/api/collect（拖拽字节/路径扫描）
 │   ├── engine.js      # 解析引擎：PDF 文本层（pdfjs）+ 数电票 XML；service 与 MCP 共用
 │   └── kvclient.js    # cap.kv 桥（自发现 anchor.json→config.json→端口扫描，zhifang 同款）
 ├── mcp/server.js      # stdio JSON-RPC，7 个 piaoxia_* 工具，直调 engine + cap.kv
 ├── shared/            # 面板/MCP/服务三方同源纯函数核心（零 IO）
 │   ├── core.js / core.d.ts / sha256.js
 ├── src/               # React 面板（esbuild bundle，external:react）
 └── test/              # mjs 裸测：单测/解析 fixture/MCP 全流程/真宿主冒烟/面板 harness
```

**数据面**：cap.kv 单事实库。
- `piaoxia.invoice.<id>` 票据实体；`piaoxia.title.<id>` 抬头；`piaoxia.settings` 设置；`piaoxia.meta` 服务心跳与端口/token（服务写、面板读）。
- id = `'p' + sha256('inv|' + 发票号码)[:12]`（无号码手录票用 `'inv-manual|' + 日期|销方|金额|品名` 种子）——内容寻址幂等，面板/AI 并发写不分裂。

**字节面**：面板拖拽 → FileReader base64 → POST `http://127.0.0.1:<meta.port>/api/collect`（token 鉴权）→ 服务解析 + 原件归档 → 返回结构化结果 → **面板统一写 cap.kv**（服务无 kv 写路径，只做引擎与归档）。

**原件归档**：解析成功后把原件复制到 `<dataRoot>/piaoxia/<发票号码>.<ext>`（dataRoot 经 anchor.json 自发现，与 kvclient 同候选链；数据方舟备份引擎若备份数据根则票据一并受保护）。归档失败降级只记 srcPath + warning，不阻塞入账。

## 五、实体与状态机

**Invoice**：`number/code/kind/title/date/buyer{name,taxId}/seller{name,taxId}/items[]/amount/tax/total/category/purpose/status/reimburseId/submittedAt/settledAt/rejectNote/warrantyMonths/warrantyUntil/source/srcPath/fileName/fileSha256/archivedPath/note/createdAt/updatedAt`

- `kind`：数电普票 | 数电专票 | 电子普票 | 电子专票 | 铁路客票 | 航空行程单 | 其他（文本关键词判定）
- `category`：餐饮|交通|住宿|办公|通讯|会话|物流|采购|其他（core.js 确定性关键词分类器，AI 可改）
- `purpose`：报销|保修|维权|存档；`status`：待报销|已提交|已到账|已退回|不报销
- 状态转移 allow-list：待报销→已提交/不报销；已提交→已到账/已退回/不报销；已退回→已提交/待报销/不报销；已到账→已提交（纠错回退）；不报销→待报销（恢复）。
- `warrantyUntil = date + warrantyMonths`，纯派生存档，透视出「保修到期榜」。

**判重三层**：fileSha256 同 → 同文件；发票号码同 → 同票（返回已有票据状态，不覆盖金额）；否则新票。

## 六、MCP 工具（7 个，description 即 prompt）

| 工具 | 语义 |
|---|---|
| `piaoxia_collect` | 扫描用户给定的文件/目录（递归可选），解析 PDF/XML 电子发票并入库；返回新增/重复/失败清单与原因 |
| `piaoxia_add` | 手动/AI 录入（纸质票、对话中直接说票）；无原件 |
| `piaoxia_query` | pending / month / category / seller / reimburse / warranty / stats / search 八型查询 |
| `piaoxia_set_status` | 报销状态流转（submit/settle/reject/reopen/archive/restore）+ 报销单号 |
| `piaoxia_update` | 改类别/用途/保修/备注/销方等字段 |
| `piaoxia_delete` | 删除（confirm 门：AI 必须先向用户确认） |
| `piaoxia_titles` | 抬头 list/add/delete，返回一键复制文本 |

## 七、面板（4 Tab）

1. **收票台**：拖拽区（PDF/XML/OFD 提示）+ 路径扫描输入 + 批量结果三色分栏（新增/重复/失败原因）；逐文件进度。
2. **票册**：过滤（状态/类别/月份/关键词）+ 列表 + 详情（状态流转、报销单号、保修期、原件路径）+ 两击删除。
3. **透视**：待报销总额与清单、本月提交/到账、按类别/月份、报销单分组、保修到期榜、CSV 导出。
4. **设置**：抬头 CRUD、导出/导入 JSON、服务状态灯、口径与边界说明。

## 八、安全与隐私

- 服务只绑 127.0.0.1 + token（meta 经 cap.kv 分发）；零外网。
- 目录扫描仅限用户/AI 显式给出的路径，不枚举家目录。
- 票据敏感字段（税号/金额/销方）只存本地 cap.kv；日志不含票据明细。
- 删除两击确认；MCP delete 需 confirm=true 且 AI 先向用户确认。
- 输入文件只读不改；归档为复制非移动。

## 九、验收

1. `node test/run-tests.mjs`：core 纯函数（状态机全转移表/判重三层/透视口径/CSV 往返/分类器/保修日期边界）。
2. `node test/parse-verify.mjs`：引擎对 fixture 断言——脚本用 pdf-lib + 本机中文字体生成两款仿真发票 PDF（数电普票版式 / 旧版增值税电子普票版式）+ 手写数电票 XML；验证 20 位号码/金额/买卖方/日期/kind 判定；无字体环境自动跳过并如实标注。
3. `node test/mcp-verify.mjs`：内存 kv 桥 + spawn 子进程全流程（7 工具、判重、状态机拒绝、confirm 门）。
4. `node test/smoke-real.mjs`：真宿主快照式清理冒烟（需 Polaris 运行中）。
5. `test/harness.html`：mock invoke 目检面板全部分支。
6. `node scripts/pack.js plugins/piaoxia` 出包，index.json 上架。

## 十、风险与止损

- **解析成功率**是核心假设：多版式（数电票/旧增值税票/铁路/航空）字段位置有差异。缓解：标签+正则双路提取、kind 分版式策略、解析失败逐文件给出可读原因并引导手动录入；票账价值不因单票解析失败而崩塌（手动兜底）。
- 若真实票据解析成功率不可接受且手动录入无法支撑价值 → 止损为「仅 XML + 手动录入的最小票账」或停止。
