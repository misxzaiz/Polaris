# 琥珀 amber —— 网页封藏馆插件 spec

> 状态：已实施于插件仓（见文末提交行）。键空间契约权威在插件仓 `plugins/amber/README.md`。

## 目标与定位

把任意网页「琥珀化」：一键把 URL 封存成**永久可读快照**——服务原生抓取（跨域根治点，与 page-sentinel/feed-radar 同一铁律），抽出干净正文 + 标题/作者/发布时间/配图，入库 cap.kv 供桌面/手机/Web 三端同读；全文检索（BM25-lite）；金句摘录；AI 经 MCP 直接「代你封存 / 代你检索 / 代你精读」。

**邻位不撞车**：feed-radar 订「源」（周期）；page-sentinel 盯「变化」；bookmark-dig 体检「书签」；news-curator 是 AI 定期刊物。琥珀收「页」——用户主动、一次性、存内容本体。原文日后失效（404/改版），琥珀是唯一遗产。

## 架构（沿用仓内已验证范式）

- `service/amber.js`：type=http 服务（`/__health`），8s tick。消费命令信箱（amberize/refresh/forget/purge/search），封存串行 + 同主机 5s 礼貌间隔，60s 心跳写 `amber.meta`，15min 清扫（默认关）。
- 跨域铁律：**全部外网抓取只发生在服务进程**（原生 fetch + SSRF 守卫 `isFetchableUrl`，拒内网/环回/云元数据）。面板与 MCP 永不直接 fetch。
- 数据面：全部 `amber.*` 键空间走 cap.kv（跨端同读；键空间必须带 `amber.` 前缀）。正文键 `amber.body.<id>`（Markdown-lite 文本，60KB cap）；条目键 `amber.item.<id>`（id = `b`+sha256(url) 前 12 位，同 URL 幂等）；摘录 `amber.quote.<qid>`；检索走信箱（`amber.cmd.search.<n>` → 结果槽 `amber.search.<n>`）。
- MCP（stdio，零依赖 JSON-RPC）：amber_save / amber_list / amber_search / amber_read / amber_mark / amber_quote / amber_delete 共 7 工具。
- 面板：esbuild ESM（external react），4 Tab（收藏/检索/摘录/设置），可见时 5s 轮询全读 item 键，body 按需读；服务 start 走 `cap.pluginDiscovery` 自举 + `cap.pluginServiceManager` 三件套。

## 关键设计决定

1. **抽取升级**（相对 feed-radar 的 article→main→body 硬切片）：候选段落祖先打分（文本长度 − 链接密度惩罚 − 噪声 class 熄灭），选最高分容器，输出 Markdown-lite（`#` 标题/`-` 列表/`>` 引用/pre 保留行）。兜底链：评分容器 <400 字 → 硬切片 → 全文去噪 → <80 字报「JS 渲染空壳」。
2. **字符集**：fetch 保留 Buffer，Content-Type header → `<meta charset>` → 默认 UTF-8，TextDecoder 解 `gb18030/big5` 等遗留编码（feed-radar 直接 utf8 是已知短板）。
3. **幂等封存**：同 URL 重复封存 = 更新正文 + `sealCount++` + 保留 `firstSealedAt`（封存时间线），不重置 read/star/tags。
4. **收藏库语义**：默认**永不自动清理**（与订阅流相反）；设置里可开 sweep（keepDays / maxItems，星标永豁免）。
5. **摘录**：阅读视图选中文本 → 存 `amber.quote.*`（冗余 itemTitle 快照，免 join）；AI 可存可列。
6. **meta charset 实体解码**：沿用 feed-radar「解码先行→剥标签、双轮」结论；剥标签正则用「像标签」形。

## 验收

- `node scripts/validate.js` 绿；面板 esbuild + tsc 通过。
- 离线单测（lib/extract/searcher/charset）全绿。
- 真实桥冒烟（服务 CLI port=0 独立跑 + 真外网）：amberize → body 入库 → search 命中 → mark/quote/delete 联动清理，跑完自清理。
- 索引发布：pack + index.json（重读现文件、保留他人条目，只新增本插件一行）。

## 提交

- 插件仓：`feat(amber): v0.1.0 琥珀——网页封藏馆插件`（Polaris-plugin `ae312b1`，index 同步于同一提交，zip sha256 `220a2019…`）。
- 本 spec：docs(plans): 琥珀 amber 网页封藏馆插件 spec（已实施于插件仓 ae312b1）。
- 验证实录：离线单测 40/40；真实桥冒烟 23/23（example.com 全链路 + MCP stdio 直连）；真实长文封存 paulgraham.com/greatwork 12316 字、无导航残渣。本机外网间歇抖动（curl 亦超时）时抓取如实记 error——已知边界见插件 README。
