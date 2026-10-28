# 格致 gezhi —— AI Excel 工厂（真实可编辑 .xlsx 交付）spec

> 状态：2026-10-29 设计+实施完成，插件仓提交 50bdd15（本会话）。
> 定位：**输入数据/清单/资料 → 交付真实可编辑的 .xlsx 文件**（原生样式/公式/条件格式，不是 CSV 裸数据）。

## 1. 一句话定位

在 AI 对话里直接把数据变成排版完整、可继续编辑的 Excel 文件：
本地直生原生 OOXML（exceljs 引擎），真公式/真条件格式/真冻结，
零额度零会员，内容不出设备；面板无需 AI 也能粘贴 CSV/TSV 本地构建下载。

## 2. 方向由来（与 qimu 的关系）

本会话原计划实施前会话已定稿的《启幕 qimu AI PPT 工厂》spec（16 候选第一名），
实施中途发现**并行会话正在实时构建 plugins/qimu**（plugin.json/mcp/src 陆续落盘，
且文件读取出现并发不一致），为避免同域撞车，转向该调研 16 候选中的**第二名：Excel 报表工厂**——
同一「文件级交付」赛道、同一平台范式，交付物不同（.xlsx vs .pptx），生态零重叠。

## 3. 需求证据

- **CSV 乱码是结构性痛点**：AI 工具导出的 UTF-8 CSV 在 Excel（默认 GBK）打开中文即乱码，
  社区反复出现解法帖（CSDN：ChatGPT 输出 excel 解析方案、AI 导出鸭专为此而生）——
  第三方转换工具的存在本身即付费需求信号。
- **复制粘贴丢格式**：AI 输出表格的剪贴板 CF_HTML 粘贴到 Excel 排版错乱（CSDN 实测文）。
- **额度墙**：云端 AI 表格能力按积分/会员收费（ChatGPT Code Interpreter、WPS AI 等），
  本地免费直出即收益。
- **xlsx 是数据交换通用语**：名单/台账/对账/库存/成绩/预算，职场周频以上。

## 4. 数据与文件契约

**Sheet Spec（camelCase，AI 面与面板共用）**：
`{ title, theme: slate|indigo|forest|crimson|plain, sheets: [{ name, caption?, columns: [{h,type,fmt?,formula?}], rows, stats?, conditional?, zebra?, freeze?, autofilter? }] }`

- 列类型：text/number/int/money/percent/date（→ Excel numFmt 映射）。
- 行公式：`=B{r}*C{r}`，{r} 引擎展开实际行号；stats 生成真实 `=SUM/AVERAGE` 公式行。
- 条件格式：gt/lt/ge/le/eq/ne/contains × warn/good/bad（expression 规则）。
- 容量护栏：≤6 表 / ≤32 列 / ≤2000 行 / 单元格 ≤200 字，超限报错引导拆分（绝不静默截断）。

**cap.kv 键空间**：`gezhi.book.<id>`（作品登记）、`gezhi.settings`（exportDir/theme）。
**文件输出**：`{exportDir}/gezhi-YYYYMMDD-HHmm-{标题净化}.xlsx`；exportDir 缺省探测 桌面→下载→家目录。

## 5. 核心机制（shared 单权威）

1. `shared/core.js`：CSV/TSV 解析（RFC4180 状态机 + 定界符探测 + 编码探测 UTF-8→GB18030→UTF-16LE）
   + 类型推断 + spec 归一化 + 布局数学（列宽按 CJK=2/ASCII=1 显示宽、区间/公式生成、条件 ref）。
2. `shared/render.js`：layout 输出 → exceljs Workbook（vendor 浏览器 UMD 单文件，node/浏览器双端）。
   **公式注入防护**：`= + - @` 前缀文本强制 richText 存储；公式只允许来自 spec formula 列与 stats。
   `fullCalcOnLoad` 保证打开即重算（引擎不写公式缓存值）。
3. 面板与 MCP 消费同一 core→render 链：预览≈成品、面板构建≈对话构建。

## 6. MCP 工具（5 个）

`xlsx_build`（spec → 落盘+登记）/ `xlsx_guide`（契约手册）/ `xlsx_recent` / `xlsx_reveal`
（仅限已登记路径，explorer/open/xdg-open 白名单）/ `xlsx_forget`（confirm 门，不删文件）。

## 7. 面板（创作/作品/设置）

创作：粘贴 CSV/TSV（或打开文件）→ 自动识别（行列/定界符/编码/列类型）→ 实时 HTML 预览
（同一 layout 几何）→ 主题/选项 chips → 本地构建 blob 下载。作品：登记列表+路径复制。
设置：导出目录（与 MCP 共享）/默认主题/隐私说明。

## 8. 安全与隐私

零外网、零后台服务；文件名净化防穿越；reveal 白名单仅登记作品；公式注入防护；
删除仅删登记；冒烟/测试备份并恢复真实设置、自清理。

## 9. 验收（全部真实执行）

- 单测 17 项（`node --test test/run-tests.mjs`）：解析/编码（含 python 生成 GBK fixture）/推断/
  归一化/布局/文件名/列字母 + **产物级验收**（spec→xlsx→python openpyxl 逐项断言：
  合并标题/表头填充/numFmt/日期百分比/行公式/SUM 汇总/双线边框/冻结/筛选/条件规则/列宽/注入防护/多 sheet/中文）。
- MCP 离线协议 8 组（mock cap.kv 桥 + stdio JSON-RPC 全流程）。
- 真桥冒烟 6 项（宿主 9829 实跑：自发现→build 落盘→recent→reveal 护栏→forget→清理）。
- 真浏览器 harness（IAB）：三 Tab 全流程 + 构建→blob 下载，**浏览器产出的文件**回传 openpyxl 验收通过。
- 浏览器打包等价代理：与 dist/panel.js 同形态 esbuild bundle 跑 writeBuffer，验证 vendor 转换无损。
- tsc --noEmit 零错误；打包 sha256 入 index.json（新增条目，v0.1.0）。

## 10. 已知边界

面板创作单次一张表（多 sheet 走对话）；行公式仅限本行引用（跨行聚合用 stats）；
GB18030 解码依赖完整 ICU（Node≥14 默认，主流浏览器均支持）；资源管理器定位的真实弹窗留待用户侧确认。
