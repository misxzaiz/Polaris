# 度支 duzhi —— 本地账单透视插件 spec（微信/支付宝流水 → 可对话的家庭消费账）

> 状态：已定案，实施于插件仓 `plugins/duzhi`。
> 选型背景：2026-10-29 会话。并行会话正在实施韦编（weibian，06:36 仍有写入）与车辖（chexia 骨架），主动让域。在 52 个已注册插件域图上另选空位：**官方账单流水导入与消费透视**零占位——pocket-ledger（手工记账）、守闸/常契（订阅契约）、票匣（发票凭证）、算盘（AI API 花销）都不吃「支付宝/微信官方导出的交易流水」。

## 一、产品机会（证据摘要，2026-10-29 检索核验）

- **「手工记账坚持不下来，导出账单做表」是公认替代路径**（腾讯云开发者/搜狐文章口径）；钱迹、BeeCount 等记账 App 均为微信/支付宝账单导入专设官方文档——「导出→导入→分析」工作流已被付费用户验证。
- **存量工具的真实缺口（可核验）**：现有方案要么把账单上传云端（隐私顾虑，本地处理更受信任——腾讯云文章明示），要么是 Python 脚本/Beancount importer（BSync、GitHub 开源，门槛高），要么已死（网易有钱微信同步失效）。**本地 + 零账号 + AI 对话查询 + 家庭三端同看**的组合真空。
- **格式痛点成熟可解**：微信账单 UTF-8 CSV（16 行头、金额带 ¥）、支付宝 GBK CSV（~24 行头，官方帮助确认 GBK）、两平台均为密码 zip 邮件交付（ZipCrypto 传统加密，Python 标准库可解即证明非 AES）——全部有开源先例可循，无不可得数据源。
- **本机真实用量信号（cap.kv 实证，2026-10-29 查 stores/kv.db）**：零录入自动类插件被持续使用（订阅雷达 287 键、网哨 163、口袋主机 103、纸坊 91），而手工台账几乎无人用（口袋账本 3 键、日晷 2、问灶 1、观止/故人/金匮/泉府 0）。度支录入成本 = 每月拖一次文件（零打字），查询面 = 随手对话——完全同型。
- **财务簇是本生态最密的一簇**（泉府/金匮/票匣/守闸/常契/算盘），用户（家庭场景）对钱相关工具有持续需求，唯独缺「真实消费流水」这一环。
- **未验证假设（如实）**：用户是否愿意每月执行一次「导出→拖入」仪式（支付宝导出要在 App 里申请邮件交付，本身有点绕）；CSV 列结构未来漂移风险（以表头名匹配而非列序匹配缓解）。

## 二、产品定义

- **名称**：度支（duzhi）——唐代度支司，掌天下财计出入；把各路流水归一成一本账的意象。
- **一句话**：把微信/支付宝官方导出的账单变成一本可对话、可透视、数据不出本机的家庭消费账——每月拖一次文件，之后全是问答。
- **目标用户**：想看清钱花哪了、但坚持不了手工记账的人；家庭共享账（夫妻各用各的支付平台，账在一台电脑汇合、三端可查）。
- **核心场景**：① 邮箱收到账单 zip → 拖进面板（或对 AI 说「帮我导入下载目录里的微信账单」）→ 自动去重入库；② 面板看月度收支柱状、分类占比、商户 top、退款口径；③ 聊天问「上月奶茶花了多少」「这个月外卖比上个月涨了吗」→ `duzhi_query`/`duzhi_summary` 现算回答；④ 导错文件一键按批次撤销。
- **独有价值**：官方流水零打字入库（对比手工记账）× 全程本地零外网（对比云端记账 App）× AI 对话查询（对比 Excel 透视）× 双平台归一 + 跨月去重（对比单平台脚本）× 批次可撤销（对比导入即定型）× 家庭三端同看。
- **安全边界（硬约束）**：无 network 权限、零后台服务进程；zip 解压密码只在内存用一次、不落盘不写日志；只读用户显式给路径的文件；不改写任何源文件；撤销以 importId 批次为界；「中性交易」（充值/理财互转）不计收支只计数——不夸大现金流。

## 三、数据模型（cap.kv 键空间 `duzhi.*`）

| 键 | 写者 | 内容 |
|---|---|---|
| `duzhi.month.<YYYY-MM>`（+#2 #3… 分片） | 面板/MCP | `{v:1, part, txns: Txn[]}` 月桶分片，**每片 ≤500 笔**（router-dispatch HTTP body 上限 1MB，中文 JSON 转义膨胀 ~3 倍；写入=整月重排分片） |
| `duzhi.import.<id>` | 面板/MCP | 批次 `{id, src, file, rows, newCount, dupCount, inFen, outFen, refundFen, span, at}` |
| `duzhi.rules` | 面板/MCP | `{rules:[{kw, cat}]}` 分类关键词规则（有序首个命中；内置默认规则 UI 可见） |
| `duzhi.cat.<txnId>` | 面板/MCP | 单笔分类覆盖 `{cat}`（recat 写入，优先于规则） |

Txn：`{id(=sha256(src|tradeNo|amountFen|date|dir) 前16), src:'alipay'|'wechat', tradeNo, mOrderNo?, date:'YYYY-MM-DD HH:mm', name, item, type, dir:'in'|'out'|'neutral', amountFen:int>0, refundFen?:int≥0, status, method, note, importId, at}`。金额一律**分**为整数存储，杜绝浮点钱。
月桶读：list 前缀 `duzhi.month.<ym>` → 全部分片 concat；写：全月 union-dedupe 后按 500/片重排重写。并发双写者（面板+MCP 同时导入）存在 lost-update 窗口——以「重导幂等补齐」为恢复口径，如实写进 README。

## 四、核心算法（shared/core.js + shared/sha256.js 纯函数三方同源）

1. **moneyToFen**：剥 `¥￥,` 空格 → 字符串拆元/分 → 整数；`0.05→5`、"1,234.56"→123456；非法/负数拒绝。
2. **decodeText**：BOM 检测 → strict UTF-8（fatal）→ 失败回退 GBK（TextDecoder 双端支持；纯 ASCII 走 UTF-8 通道）。都失败 → 报「请另存为 UTF-8」。
3. **zip 解包（shared/core.js 内置，零依赖）**：EOCD 扫描 → 中央目录 → 本地头跳过 → ZipCrypto 解密（crc32 表 + 三密钥流；校验字节 == crc 高位或 modTime 高位）→ inflateRaw（Node 走 `process.getBuiltinModule('zlib')` 运行时取，浏览器走 DecompressionStream('deflate-raw')；**不静态 require，避免 esbuild 打穿浏览器 bundle**）；method=99（AES）→ 明确报「请手动解压后拖 CSV」。
4. **CSV 解析**：RFC4180（引号/双引转义/\r\n/逗号内含）；表头**按列名匹配**（括号全半角归一）而非列序——抗平台格式微调。
5. **双解析器**：detectSource（「微信支付账单明细」/「支付宝交易记录明细」签名 + 表头词兜底）；wechat（收/支：收入/支出/中性交易；金额剥 ¥）；alipay（逗号或 `|` 分隔自适应；dir 缺省或状态含「关闭/失败」→ neutral；成功退款列 → refundFen；日期取付款时间缺省回落创建时间）。
6. **归并**：union by id 幂等；月桶分片重排；批次汇总（new/dup/in/out/refund）。
7. **透视 aggregate**：月度 in/out/refund/net、分类 outFen 占比（dir=out；退款类交易单列不计支出）、商户 top、时间范围过滤；口径注明。
8. **分类 categorize**：覆盖 `duzhi.cat.*` > 规则首个命中（kw ∈ name+item+type）> 内置默认（餐饮/咖啡奶茶/交通/购物/居住/娱教医通讯等）> 其他。
9. **撤销 forget**：按 importId 从月桶移除 + 删批次键；先预览（笔数/跨度/金额）后 confirm 门。

## 五、架构（复用 jinkui/qingnang 零服务范式）

- `shared/core.js` + `shared/sha256.js`（jinkui 同款拷贝）：零依赖纯函数核心，面板（esbuild 打入 bundle）、MCP（require）、测试三方同源。
- `mcp/kvclient.js`：端点自发现 + router_dispatch 透传 cap.kv（feed-radar/clip-relay/jinkui 同款实测样板，勿改协议）。
- `mcp/server.js`：stdio JSON-RPC，6 工具 `duzhi_import(path,password?) / duzhi_summary(month|from,to) / duzhi_query(keyword,category,dir,min,max,from,to,limit) / duzhi_rules(add|remove|list) / duzhi_recat(keyword|txnId,category) / duzhi_forget(importId,confirm)`；import 直接 fs 读路径（zhifang MCP 先例），文件读一次进内存不缓存；输出带「不构成理财建议」口径。
- `src/` 面板四 Tab：**导入**（拖拽区 + 密码框 + 预览确认 + 批次历史 + 撤销）、**总览**（月选择 + 四统计卡 + 分类占比条 + 商户 top + 净流趋势 + 口径注）、**明细**（月/方向/分类/关键词筛选 + 表格 + 行内改分类 + 导出 CSV/JSON）、**规则**（关键词规则增删 + 内置规则表 + 安全与隐私说明）。数据走 `__POLARIS_HOST_INVOKE__ → router_dispatch → cap.kv`；导入解析全在浏览器本地完成（FileReader → core.parseBillFile），无服务无上传。
- 图标 `CheckSquare`（对账勾稽，白名单 18 值内）；order 93；permissions 仅 `appConfigRead + aiToolAccess`（**无 network**）；enabledByDefault true。

## 六、验收

1. `node test/run-tests.mjs` 离线单测全绿：crc32 标准向量、ZipCrypto 往返（测试自带加密写手生成加密 zip fixture）、zip 边界（AES 拒/错密码/非 zip/多入口）、decodeText（UTF-8/GBK fixture/纯 ASCII）、CSV 引号转义、wechat/alipay 解析（¥/中性/退款/关闭单/`|` 分隔/付款时间缺省）、moneyToFen、id 稳定性与跨源不撞、月桶分片（>500 笔重排/幂等重导/forget 移除）、aggregate 口径、categorize 优先级、规则增删。
2. `node test/mcp-verify.mjs` 内存桥 spawn 真 server：6 工具全流程（import alipay/wechat fixture → 重复导入全 dedup → summary/query → rules/recat → forget 预览+confirm 门+生效 → 坏路径/错密码/非账单诚实报错）。
3. `node test/harness-run.mjs` jsdom 真面板：四 Tab 种子渲染 + file input 走真实导入代码路径写内存 kv + 改分类 + 撤销批次。
4. `node test/smoke-real.mjs` 真宿主快照式冒烟（需 Polaris 运行中）。
5. `npm run build`（esbuild）+ `npm run typecheck`（tsc strict）；publish 后 plugin.json / update.json / index.json 三处 version 与 sha256 一致。
6. 面板与 MCP 输出均带「只做统计透视，不构成理财建议」口径；无 network 权限、无服务进程、密码不落盘。
