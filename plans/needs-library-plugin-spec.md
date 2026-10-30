# needs 需求库系统 spec（插件 + 夜班管道）

> 状态：已实施 v0.2（插件仓 `plugins/needs` + 需求库 `needs/`，本文为系统级记录）。
> 唯一权威：需求库公约 `Polaris-plugin/needs/README.md`（状态机、字段、禁区）；本文只记系统结构与决策。

## 目标

把「记录需求 → 夜里免费消化 → 交付插件」跑成一条不依赖任何单个会话记忆的管道：

- **白天（Polaris，手机 PWA 可用）**：对 AI 说一句话 → `needs_add` 落档（自动序号/模板/状态）。
- **夜里（ZCode 闲时 token）**：定时巡逻消费条目——分析（idea→analyzed）、写 spec（analyzed→specd，落本仓 plans/）、实施 approved 条目（→delivered，本地 commit 不 push）。
- **人只做两个动作**：记想法、拍板（approved 只能人工设置）。

## 所有者与两端注册

| 端 | 注册方式 | 说明 |
|---|---|---|
| Polaris | `plugins/needs/plugin.json` → mcpServers stdio | zip 安装；`needs_config` 指定根目录一次 |
| ZCode | 主仓 `.zcode/config.json` → `mcp.servers.needs` 指向**同一份** `server.js` | 源码直连，改文件下会话生效 |

- 根目录解析：`--needs-root` 参数（ZCode）> `<appConfigDir>/needs-root.json`（Polaris 副本）> 相对探测（源码仓）。
- 单机双写者：一需求一文件隔离 + O_EXCL 撞号递增 + `needs_update` mtime 乐观锁 + tmp+rename 原子写。

## 接口

AI 六工具（前缀 `needs_`）：`config`（根目录读/设）、`add`、`list`（含 mtimeMs）、`show`、`update`（fields+append，乐观锁）、`handoff`（渲染 `needs/prompts/{analyze,write-spec,build-plugin}.md` 为开工任务书，槽位 `{{ROOT}}/{{ENTRY_PATH}}/{{ID}}/{{TITLE}}/{{BODY}}`）。

**v0.2 面板（仅 Polaris 宿主）**：逻辑核唯一（`shared/core.js`），MCP stdio 与面板 http 服务（`service/needs-service.js`，127.0.0.1+token，token 持久于 cap.kv `needs.meta`）两个薄壳共用。面板：状态分组看板、卡片详情、拍板（approved 仅人工+confirm）、回答待澄清、追加决策记录、一键复制开工提示词、根目录探测/保存。ZCode 侧无面板（宿主无自定义 UI 容器，用户定案）：继续走 MCP 工具 + 夜班 automation。

夜班公共资产：`needs/prompts/platform-constraints.md`（平台坑清单，每次实施后回写新坑——自改进）。

## 验收（v0.1 + v0.2 已执行）

- MCP 临时根目录冒烟：六工具 + 乐观锁冲突拒绝 + 非法状态拒绝 + 中文 slug 回落 + handoff 渲染——全过；v0.2 重构后回归冒烟复跑——全过。
- 服务 API 冒烟（真实起服 + token）：`/__health`、401 鉴权、list/add/slug、`NEEDS_CONFLICT` 冲突码、正确锁更新+待澄清追加落节、handoff、config、probe、UTF-8 中文全链路（Node 客户端验证；Git Bash curl 控制台 GBK 编码碎中文是客户端现象，服务端无误）。
- 面板：`tsc --noEmit` 通过，esbuild 产物 26.8KB（external react 宿主提供）。
- 打包：`.pluginignore` 排除 node_modules/src 后 7 文件零依赖运行时。

## 明确不做

- 面板看板（v2 再议）；共享 http 单例服务（单机双 stdio 进程够用，过设计）；夜班 push/tag/动 index.json（发布是人的动作）。
