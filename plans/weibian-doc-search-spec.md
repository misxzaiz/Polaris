# 韦编 weibian —— 本地文档全文检索与 AI 检索工具插件 spec

> 状态：已定案并实施（2026-10-29，插件仓 `plugins/weibian` v0.1.0）。
> 验证：core 单测 14 组 + 引擎级 15 组（真 spawn 服务+内存桥：建索引/中英GBK/docx/PDF 检索/越界拒绝/增量对账/清空重建）+ MCP 全流程 15 项（真 spawn stdio：4 工具/缺参/服务死后诚实报错）+ jsdom 渲染 28 项（搜索→高亮→预览→设置写库→确认门）+ 真宿主冒烟 9 步（真桥自发现/真 kv/快照式清理）全绿；tsc strict + esbuild 自包含；plugin.json/update.json/index.json 三处版本与 sha256 一致。
> 实施中两处与 spec 的偏差（均为增强）：① 服务监听 0.0.0.0（spec 原写 127.0.0.1）——手机端检索必需，安全姿态与 pocket-drop 一致（业务端点一律 token 鉴权）；② 面板「常用目录建议」进 Tab 即探测（原设计要点「添加」才出）。
> 选型背景：2026-10-29 会话。并行会话正在实施车辖（chexia，03:39 仍有写入）与金匮（jinkui，06:01 仍有写入），主动让域。在 49 个已注册插件域图上另选空位：**本地文件内容检索**零占位——bookmark-dig（浏览器书签）、time-sift（AI 会话）、amber（网页快照）、disk-radar（文件名/体积）都不碰「文件内容」。

## 一、产品机会（证据摘要，2026-10-29 检索核验）

- **「写过/看过但找不到」是高频真实痛点**：Obsidian 社区长期抱怨检索——默认搜索只列笔记不排文件名（reddit r/ObsidianMD "How to find notes"）、文件名全匹配不置顶、obsidian.nvim 检索 10–20 秒（GitHub issue #421）、索引卡死要重建（tryorbye 案例库）。Windows 自带搜索慢且弱；Everything 只有文件名。
- **存量工具的真实缺口（可核验）**：AnyTXT 免费好用但被诟病——无法删除已建索引、无法限定索引目录/类型、资源占用高、难退出（官方论坛 + SourceForge 评价区）；DocFetcher Java 老旧，Pro 版 $40。
- **「手机搜电脑文档」结构性真空**：调研未发现任何轻量方案，社区解法是远程桌面（Chrome RD/RustDesk 跑桌面检索工具）或自建 AnythingLLM（部署门槛高）——三端同读正是 Polaris 面板的既有强项（pocket-drop 已验证手机浏览器通道）。
- **宿主 AI 无内容检索能力（本仓核验）**：`cap.fs` 只有 read/list/exists/getFileInfo，对话 AI 无法「在我的文档里找关于 X 的内容」。time-sift 只覆盖 AI 会话历史，不覆盖本地文件。
- **本机真实用量信号（cap.kv 实证）**：生产数据根里自动采集类插件（网络哨兵 165 键、口袋主机 92 键、算盘自动归集）被持续使用，而 20+ 个手工台账插件日活数据为零——**零录入、后台自动**的形态已被用户用脚投票验证。韦编索引全自动（配一次目录，之后零录入），完全同型。
- **未验证假设（如实）**：除本机用户外，Polaris 用户群里「重度本地文档工作者」的占比是推断；AnyTXT 免费存在意味着「能搜」本身不是卖点，卖点在「AI 可调用 + 三端 + 可控索引」的组合。

## 二、产品定义

- **名称**：韦编（weibian）——韦编三绝，孔子读《易》翻断编绳；把本地文档「读透串起」的意象。
- **一句话**：把散落在本地文件夹里的 md/txt/PDF/docx/网页/代码变成一条命令可搜、AI 可引用、手机可查的全文索引——配一次目录，之后零录入。
- **目标用户**：本地文档多（笔记/spec/论文/合同/导出记录）且已经在用 AI 工作的人；想在手机上翻家里电脑资料的人。
- **核心场景**：① 面板输入「缓存 假象」→ 命中 spec/笔记/会话导出，片段高亮、点开预览；② 对 AI 说「帮我在文档里找关于两总线架构的论述」→ `weibian_search` 返回命中文件与片段 → `weibian_read` 取全文引用；③ 手机打开 Polaris 搜桌面电脑里的文档；④ 后台增量扫描，新文件自动进索引。
- **独有价值**：AI 可调用（宿主 AI 首次拥有本地内容检索）× 三端同读 × 可控索引（目录白名单/排除表/上限，AnyTXT 反面）× 纯本地零外网（无 network 权限）× CJK bigram+unigram 混合分词零依赖 × 增量指纹扫描。
- **安全边界（硬约束）**：只索引用户显式配置的根目录；`read` 工具路径必须落在根内（realpath 归一防穿越）；零外网请求（不申请 network 权限）；不改/不删任何用户文件；索引明文存本机数据根（与文件本身同信任域，如实披露）；OneDrive 占位文件会按预算缓慢水合（如实披露，靠限速+上限兜底）。

## 三、数据模型

**cap.kv 键空间 `weibian.*`（小而少，正文索引不进 kv）**

| 键 | 写者 | 内容 |
|---|---|---|
| `weibian.settings` | 面板 | `{roots:[], extraExcludes:[], maxDocs:5000, maxFileMB:20, maxTextKB:256, includeHidden:false, enabled:true}` |
| `weibian.meta` | 服务 | `{token, port, v}`（zhifang 范式：面板/MCP 读它直连服务） |
| `weibian.stats` | 服务 | `{docs, bytes, tokens, lastScanAt, lastScanMs, errors[≤5], byExt:{}, scanning:{pending,done}}`（内容不变不写） |
| `weibian.recent` | 面板 | 最近 20 条搜索词（面板自查自用） |

**索引存储（服务自有，不进 cap.kv）**：`<appConfigDir>/weibian-index/docs/<docId>.json`，每文档一文件：`{id,path,name,ext,root,mtime,size,addedAt,textBytes,text?,tokens:[[tok,tf]…]}`（text ≤128KB 内嵌，超阈值置 null 按需重提取）。docId = sha256(realpath) 前 12 位；改名/移动视为新文档+旧文档删除（增量对账按 mtime+size 指纹）。

## 四、核心算法（shared/core.js 纯函数，服务/MCP/测试三方同源）

1. **tokenize**：lowercase 后按 run 切分。ASCII run `[a-z0-9_+#]+` 长度 ≥2 入索引；CJK run（\u3400-\u9fff 等 ideographs）**unigram+bigram 双层**（bigram 保相邻精度，unigram 支持单字查询）；跨语边界邻接丢失（如实披露）。查询与索引用同一函数。
2. **BM25**：k1=1.2、b=0.75，idf=ln(1+(N−df+0.5)/(df+0.5))，查询词 tf 求和；文件名全词命中 ×1.5、部分命中 ×1.2、路径段命中 ×1.1。
3. **snippet**：查询词在文本中的最密 256 字窗口，返回 `{text, hits:[{start,end}]}` 供面板 `<mark>` 高亮与 AI 引用。
4. **pathRules**：扩展名白名单分类（text/pdf/docx/html/skip：md/txt/code 系 20+ 种 + pdf + docx + html/htm）；默认排除表（node_modules/.git/target/dist/build/out/.zcode/.venv/__pycache__/.obsidian/.idea/.vscode/AppData 段）；隐藏文件/目录默认跳过；`containsPath` realpath 归一后前缀判定。
5. **normalizeSettings**：默认值回填、roots/排除表清洗（绝对路径去重）、数值钳制（maxDocs 100–20000 等）。
6. **查询语法**：`ext:pdf dir:plans 词…` 前缀过滤器内联解析，余词进 BM25。

## 五、架构（复用已验证范式）

- `shared/core.js`（+`shared/sha256.js`，chexia/jinkui 同款）纯函数核心，零依赖。
- `service/weibian.js` 后台服务（type=http + /__health，127.0.0.1 + token，zhifang/feed-radar 混合范式）：
  - 启动装载索引目录 → 内存倒排 → 指纹对账 → 预算化扫描（25 文件/tick × 600ms，全量 5000 文档 ≈ 2 分钟不卡盘）→ 10 分钟周期增量重扫；设置热读 30s。
  - 提取器：文本类（BOM→UTF-8 严格→GBK 回退，二进制 null 比例判废）、PDF（复用 zhifang vendor/pdfjs.min.js，Node stub 消音套路照抄）、docx（最小 zip 读取器：EOCD 扫描+中央目录+zlib.inflateRaw+`word/document.xml` 的 w:t/w:p 剥取）、html（script/style 剥离+实体解码，amber 套路）。
  - API：`/api/search`、`/api/read`（含偏移，面板预览与 AI 同入口）、`/api/reindex`、`/api/progress`；stats/meta 落 kv。
  - 零外网请求；文件只读；扫描错误计数不中断。
- `service/kvclient.js`：端点自发现 + router_dispatch 透传 cap.kv（page-sentinel/clip-relay/pocket-host 同款样板，勿改协议）。
- `mcp/server.js`：stdio JSON-RPC（jinkui 模板），4 工具：`weibian_search {query,limit?,ext?,dir?}` / `weibian_read {path,offset?,maxChars?}` / `weibian_status` / `weibian_reindex`。经 meta 读 token 直连服务；服务不在时如实报错并提示面板唤醒。工具输出带「引用请给完整路径」约定。
- `src/` 面板三 Tab：**搜索**（输入框+扩展名筛选片+结果列表片段高亮+预览抽屉+最近搜索）、**索引**（根目录管理+扫描进度条+统计卡+排除与上限设置+重建确认+安全说明）、**指南**（检索语法/AI 用法示例/已知限制/隐私口径）。数据：kv 走 `__POLARIS_HOST_INVOKE__`；搜索/预览/进度走 127.0.0.1 直连自家服务（pocket-drop 验证过的 localhost 免混合内容通道）。
- 图标 `BookOpen`（白名单 18 值内，藏书意象）；order 90（挨着纸坊 88）；permissions 仅 `appConfigRead + aiToolAccess`（**无 network**）。

## 六、验收

1. `node test/run-tests.mjs` 离线单测全绿：tokenize（CJK/ASCII/mixed/空串/单字/bigram 边界）、BM25（df 边界/空查询/排序单调）、snippet（密窗口/无命中/转义/偏移正确）、pathRules（默认排除/隐藏/大小/白名单/containsPath 穿越）、normalizeSettings（钳制/坏值）、查询语法（ext:/dir: 前缀）、docx XML 剥取、html 剥离、GBK 回退。
2. `node test/engine-verify.mjs` 引擎级：临时 fixture 树（md/txt/gbk/html/docx/pdf-lib 生成 PDF）建索引→中/英/混合/ext/dir 过滤/文件名置顶→snippet 高亮→read 越界拒绝→增量（改 1 文件只重提取 1 文件）→删除/新增对账→错误文件不致命。
3. `node test/mcp-verify.mjs` 内存桥 + 真 spawn 服务：4 工具全流程（status→search→read→reindex），meta 鉴权，服务不在时诚实报错。
4. `node test/harness-run.mjs` jsdom 渲染：三 Tab 有种子数据渲染不崩、搜索写入结果、设置写入内存 kv。
5. `node test/smoke-real.mjs` 真宿主快照式清理冒烟（需 Polaris 运行中）。
6. esbuild 面板自包含 + tsc strict；plugin.json 过 forge_lint；update.json / index.json 三处版本与 sha256 一致后上架。
