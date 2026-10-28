# 纸坊 zhifang —— 本地 PDF 工坊插件 spec

> 状态：已定案，实施于插件仓 `plugins/zhifang`。
> 选型背景：2026-10-29 会话。文档域盘点：启幕（PPT 工厂）/格致（Excel 工厂）覆盖「生成」，**「操作」空置**——46 插件零 PDF 能力，主仓也无任何 PDF 处理代码（grep 实证）。与观止（书影音账本）、琥珀（网页封存）、拾光机（会话记忆）均无域交叠。

## 一、产品机会（证据摘要，2026-10-29 检索核验）

- **需求盘子是全网顶级**：「merge PDF」是 SEO 文献里的经典 head keyword（与「used cars for sale」并列举例），「merge PDF online」日访问量以百万计，iLovePDF 在印度流量可比 Amazon（检索核验）；「compress/合并 PDF」在中文生态同样是长年内容农场的必争词。
- **在线方案的隐私缺口是已验证的卖点**：iLovePDF/Smallpdf 必须把文件**上传到别人服务器**处理，daily.dev 2026-01 专文《The Private Alternative to iLovePDF & Smallpdf》直指此点；合同/简历/账单/病历类文件上传即泄露面。
- **免费限制真实存在**：Smallpdf 免费版每日任务次数限制、iLovePDF 弹窗广告+部分功能次数限制（知乎/什么值得买实测帖）；本地免费方案 PDF24 需另装独立软件、Stirling-PDF 需 Docker 自托管（数万 star 证明本地化需求真实且能商业化，但门槛把多数人挡在门外）。
- **竞品全部无「对话式操作」**：ChatPDF 类产品是「问 PDF 内容」，不是「操作 PDF 结构」；PDF24/Stirling 均纯 GUI。AI 说「把桌面这三份合同按顺序合并，输出到桌面」一句话完成 vs 打开软件→拖文件→排序→另存，是可辩护的交互差。
- **平台适配完美**：文件操作正是平台 KB 明示的下沉路径（插件拿不到 cap.fs → 服务进程 Node fs）；面板拖拽走 `<input type=file>`（本地文件不经 CORS）+ 127.0.0.1 直连自家服务（pocket-drop 已验证通道）。
- **未验证假设（如实）**：① 用户是否愿意为「对话式 PDF 操作」改变习惯（GUI 党可能不迁移）——面板拖拽兜底，两条路都通；② pdfjs 对老式无 ToUnicode 映射 CJK PDF 的抽取质量——fixture 实测通过即验收，失败路径给明确错误信息；③ 压缩是三大高频需求之一但纯 JS 做不了真压缩——**v1 明确不做**（不做假压缩），README/工具描述如实声明，路线图留给外部引擎探测。

## 二、产品定义

- **名称**：纸坊（zhifang）——造纸之处为坊；PDF 即「电子纸」，纸坊者，加工纸的地方。
- **一句话**：把「合并、抽页、拆分、旋转、图片转 PDF、提取文字」这些最高频 PDF 操作，变成 AI 对话里的一句话 + 面板里的拖拽，**全程本地处理、文件不出机器**。
- **目标用户**：每天跟文档打交道的办公族/学生/开发者；在意隐私（合同/简历/账单不上传）；不想为一次合并装一个软件或开会员的人。
- **核心场景**：① 对 AI 说「把桌面上 a/b/c.pdf 按顺序合并成一个」→ 落盘桌面，返回页数与大小；② 「把这份 60 页合同的第 3-12 页抽出来」→ 新文件（新文档不携带原文档元数据，天然满足「去痕迹分享」）；③ 「这堆扫描图转成一个 PDF」；④ 「把这份 PDF 的文字提出来」→ AI 直接读内容续答；⑤ 面板拖拽一堆文件 → 选操作 → 输出到桌面/指定目录；⑥ 手机打开面板看最近任务历史。
- **独有价值**：本地零上传零次数限制 × AI 对话式操作（竞品空白）× 永不覆盖永不删除（输出自动改名，安全底线）× 面板与 AI 同引擎同结果 × 零外部服务零账号。
- **安全边界（硬约束）**：零外网请求（服务/MCP 全程无 fetch 外网）；输入永不修改、永不删除；输出永不覆盖（存在即加 `-2`/`-3` 后缀）；拒绝加密 PDF（明示「不支持密码文件，也不做破解」）；上传总量上限（默认 128MB）可调；服务只绑 127.0.0.1 + 自生成 token。

## 三、数据模型（cap.kv 键空间 `zhifang.*`）

| 键 | 写者 | 内容 |
|---|---|---|
| `zhifang.settings` | **仅面板** | `{outDir:'', maxUploadMB:128, historyCap:200}`（服务每 op 热读；outDir 空=输出到源文件目录/桌面） |
| `zhifang.meta` | **仅服务** | `{port, token, version, pid, startedAt, lastTickAt, bridge, degraded}`（token 供面板直连鉴权；本地 sqlite 存储，服务仅绑回环） |
| `zhifang.history.<ts-id>` | **仅服务** | 任务记录 `{id,at,op,source:'panel'\|'mcp',inputs:[names],outputs:[{name,path,size}],pages,ms,ok,error?}`，环形 cap 200 |
| `zhifang.cmd` | 面板写 | 命令键 `{action:'clearHistory'}`（先删后做，单写者纪律） |

## 四、核心纯函数（shared/core.js 面板/MCP/服务三方同源，零依赖）

1. **parsePageSpec(spec, pageCount, mode)**：`'1-3,5' | 'all' | number | int[]`；ordered 模式保序允许重排（`'3,1,2'`，重复报错）、set 模式排序去重；1-based；`3-end` 支持；0/负数/越界/start>end/空 全部中文报错。
2. **sanitizeStem(name)**：去掉 Windows 非法字符 `[\\/:*?"<>|]` 与控制符，防输出名注入路径。
3. **pickOutputName(dir, stem, ext, existsSync)**：冲突自动 `-2/-3` 递增（永不覆盖）。
4. **isPdfBytes(buf)**：头 1024 字节内找 `%PDF-`（容忍前导垃圾字节）。
5. **normalizeSettings**：类型钳制与上限（maxUploadMB ≤ 1024）。
6. **formatBytes / compactRanges(pages)**：人类可读（`1.2 MB` / `3-12`）。
7. **describeInfo(info)**：给 AI 的单行结构化摘要。

## 五、架构（复用平台已验证范式）

- **service/main.js**（http 型 + /__health）：绑 127.0.0.1，token 鉴权（自定义头触发预检=CSRF 免疫），CORS 放行；`POST /api/op {op,files:[{name,b64}],params}` 面板上传字节→落盘输出；`POST /api/probe` 目录探测（桌面候选链：`~/Desktop`→`~/OneDrive/Desktop`→`~/OneDrive/桌面`→`~/桌面`→home）；消费 `zhifang.cmd`；60s 心跳；日志 `<appConfigDir>/zhifang.log` 512KB 轮转。
- **service/pdf-engine.js**：vendor `pdf-lib`（UMD require）+ `pdfjs-dist@3.11.174 legacy`（Node 24 实测文本抽取通过）；ops：`info/merge/extract/split/rotate/delete/images2pdf/text`；全部读入内存→新文档另存（输入只读）；rotate 按 delta 累加（(cur+angle+360)%360）；delete=重建文档；split 按 every 页均分零填充编号。
- **mcp/server.js**：stdio JSON-RPC，**5 工具** `zhifang_info / zhifang_merge / zhifang_pages(action: extract|split|rotate|delete) / zhifang_images2pdf / zhifang_text`；输入要求绝对路径（中文报错引导）；zhifang_text 直接回传文本（截断 20k 字）供 AI 续答；登记历史到 kv（降级容忍，核心操作不依赖桥）。
- **src/ 面板三 Tab**：工作台（拖拽/选文件→操作卡（按文件类型给可用操作）→参数（页码范围 core 同源校验）→127.0.0.1 直连执行→结果卡带输出路径）/ 历史（kv 读，按 op/来源过滤，清空走 cmd 键）/ 设置（输出目录文本框+探测按钮、上传上限）；手机端只读历史+设置（如实提示上传需桌面端）。
- 图标 `Files`（白名单内，文件域已有 data-ark/disk-radar/pocket-drop 三例复用惯例）；order 88（空位）。

## 六、验收

1. `node test/run-tests.mjs` 离线单测全绿：页码规格（~35 断言：all/end/越界/0/负/reversed/重复/全空格）、输出改名冲突链、stem 消毒、magic bytes、settings 钳制、compactRanges。
2. `node test/engine-verify.mjs` **产物级验收**（自造 PDF/PNG/JPG fixture）：merge 页数与顺序、extract 保序+元数据剥离断言、split 份数与零填充、rotate 角度读回、delete 页数、images2pdf 页尺寸、text 抽取内容逐字比对（`marker-1001`）、损坏文件错误路径。
3. `node test/mcp-verify.mjs` stdio 全流程：initialize→tools/list（5 工具）→五工具真实文件操作→错误路径（不存在/非 PDF/相对路径）isError 中文提示。
4. `node test/render-verify.mjs` 面板 SSR 断言（mock bridge）：三 Tab 渲染、操作卡上下文可用性、页码校验消息。
5. `node test/smoke-real.mjs` 真实宿主桥：kv 往返 + 服务 HTTP op 全链路（宿主不在时如实标注 skipped）。
6. esbuild 自包含 + tsc strict；plugin.json / update.json / index.json 三处版本与 sha256 一致。
7. 压缩/加密/OCR 三项能力**不做**且三处（README/工具描述/面板）如实声明。
