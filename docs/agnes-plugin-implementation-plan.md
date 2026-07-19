# Agnes 多模态插件 实施方案（生图 + 生视频）

> 版本：1.0　日期：2026-07-05
> 目标：将 Agnes 图像/视频生成能力以 **Polaris 内置插件（builtin plugin）** 形态接入，对标 `requirement`/`todo` 插件。
> 状态：规划（未实施）。API 契约已用测试 Key 实测验证。

---

## 0. API 实测结论（已用测试 Key 验证）

Base URL：`https://apihub.agnes-ai.com`

| 能力 | 模型 | 端点 | 同步性 | 实测结果 |
|------|------|------|--------|----------|
| 生图 | `agnes-image-2.1-flash` | `POST /v1/images/generations` | 同步(数秒) | 返回 `data[0].url` 或 `data[0].b64_json` |
| 生视频-创建 | `agnes-video-v2.0` | `POST /v1/videos` | 异步 | 返回 `video_id`(长 base64) + `task_id` + `status:queued` |
| 生视频-查询 | — | `GET /agnesapi?video_id=<VIDEO_ID>` | 轮询 | 完成后 `status:completed`,下载地址在顶层 **`url`** 字段 |

关键实测事实（与文档的补充/纠偏）：
1. 视频 3.4 秒时长实测耗时 **~100 秒**;10 秒视频预计 300s+。轮询超时须按此设计。
2. 创建返回的 `video_id` 是**长 base64 串**,查询用它;查询响应里的 `id` 是短规范 id（`video_xxxx`）。以创建返回的 `video_id` 作为轮询键。
3. 视频完成态下载字段是顶层 **`url`**（`https://platform-outputs.agnes-ai.space/.../xxx.mp4`）。`remixed_from_video_id` 现恒为 `null`（仅对 remix 任务承载源视频 id），早期文档曾把下载链接放在该字段，已废弃；代码保留其作为旧版兜底。2026-07-19 实测复核确认。
4. 图像响应含文档未列字段：`background`/`output_format`/`quality`/`usage`;解析时按需忽略。
5. `num_frames` 须满足 `8n+1` 且 ≤441;`size` 由服务端映射到最近标准分辨率（如请求 1152x768 实际输出 1088x832）。

---

## 1. 架构决策

### 1.1 形态：内置插件（builtin plugin），双端注册

Polaris 的内置插件（如 `requirement`）需要**两处注册**：

- **Rust 侧**（进程拉起）：`mcp_config_service.rs` 的 builtin 列表 + `[[bin]]` + tauri 打包 externalBin。
- **前端侧**（面板/开关/AI 可见）：`src/plugins/agnes/manifest.ts` + `builtinPlugins.ts` 注册 + 面板懒加载。

> ⚠️ 上一次被回滚的尝试（`be2d7a58`）**只做了 Rust 侧**（`agnes_mcp_server.rs` + bin + `mcp_config_service` 注册 + 一个聊天内联渲染器），**没有前端 manifest/面板**,因此不是真正的可开关插件。本方案补齐前端侧,并按最新接口文档修正 Rust 侧。

### 1.2 可复用资产

被回滚提交可作脚手架取回，但**需按本文档接口修正**（端点/参数/查询方式已变）：
```
git show be2d7a58:src-tauri/src/services/agnes_mcp_server.rs   # 862 行 MCP server 骨架
git show be2d7a58:src-tauri/src/bin/polaris_agnes_mcp.rs        # bin 入口
git show be2d7a58:src/components/Chat/chatBlocks/MediaPreviewRenderer.tsx  # 聊天内联渲染(二期)
```
复用价值：JSON-RPC 骨架、blocking reqwest 客户端、tools/list 结构、单测框架。
须改写：图像 `extra_body` 结构、视频 `num_frames/frame_rate/8n+1`、查询改 `/agnesapi?video_id=`、下载字段 `url`（旧 `remixed_from_video_id` 兜底）。

---

## 2. 文件清单

### 2.1 Rust 侧（`src-tauri/`）
| 文件 | 动作 | 说明 |
|------|------|------|
| `src/services/agnes_mcp_server.rs` | 新增 | MCP server 主体（取回骨架 + 按文档改写） |
| `src/services/mod.rs` | 改 | `pub mod agnes_mcp_server;` |
| `src/bin/polaris_agnes_mcp.rs` | 新增 | bin 入口（仿 `polaris_requirements_mcp.rs`） |
| `Cargo.toml` | 改 | 新增 `[[bin]] name="polaris-agnes-mcp"` |
| `src/services/mcp_config_service.rs` | 改 | 注册 builtin contribution（server/bin 名、路径前缀、args 模式、env 覆盖键） |
| `tauri.conf.json` / `tauri.windows.conf.json` | 改 | externalBin 打包 `target/release/polaris-agnes-mcp` |

### 2.2 前端侧（`src/`）
| 文件 | 动作 | 说明 |
|------|------|------|
| `src/plugins/agnes/manifest.ts` | 新增 | `PolarisPluginManifest`（views + mcpServers + permissions） |
| `src/plugins/agnes/AgnesPanel.tsx` | 新增 | 生图/生视频面板 + 结果画廊 |
| `src/plugins/agnes/api.ts` | 新增 | 前端调 4 端点（经 tauri 代理，见 §4.3） |
| `src/plugin-system/builtinPlugins.ts` | 改 | 注册 manifest + `pluginPanelRegistry.register('agnes', ...)` 懒加载 |
| `src/plugin-system/types.ts` | 核对 | `PluginIconId` 已含 `'Film'`,可直接用 |
| `src/locales/{zh-CN,en-US}/*.json` | 改 | 面板标签 `labels.agnesPanel` 等 i18n |

---

## 3. MCP 工具设计

面向 AI agent 暴露 4 个工具（`tools/list`）：

### 3.1 `generate_image`
入参：
```jsonc
{
  "prompt": "string (必填)",
  "size": "1024x1024 | 1024x768 | 768x1024 (默认 1024x1024)",
  "images": ["string[] 可选：图生图输入,URL 或 data:image/...;base64,"],
  "response_format": "url | b64_json (默认 url)"
}
```
组包规则（按文档）：
- 顶层：`model=agnes-image-2.1-flash`、`prompt`、`size`。
- 有 `images` → 写入 `extra_body.image`（图生图）;`response_format` **必须**放 `extra_body`。
- 无 `images` 且要 base64 → 顶层 `return_base64:true`（文生图）。
返回：`{ url? , b64_json? , revised_prompt? }`（统一为 data URL 或直链，供聊天渲染）。

### 3.2 `generate_video`
入参：
```jsonc
{
  "prompt": "string (必填)",
  "width": 1152, "height": 768,
  "num_frames": 121,      // 校验 8n+1 且 ≤441,非法则纠正到最近合法值并回报
  "frame_rate": 24,
  "image": "string 可选：单图(图生视频)",
  "images": ["string[] 可选：多图/关键帧,写入 extra_body.image"],
  "mode": "ti2vid | keyframes 可选",   // keyframes 写入 extra_body.mode
  "seed": 0, "negative_prompt": "", "num_inference_steps": 0,  // 可选透传
  "wait": true,           // true=阻塞轮询直到完成/超时;false=仅创建后返回 video_id
  "timeout_sec": 300      // wait=true 时的轮询上限,默认 300,上限 360
}
```
行为（见 §5）：`wait=true` 内部轮询直至 `completed` 返回下载 URL;超时或 `wait=false` 返回 `{ video_id, status, progress }` 供后续 `query_video`。
参数校验：`num_frames` 不满足 `8n+1` 时,向下取整到最近 `8n+1`（并在返回里注明修正）。

### 3.3 `query_video`
入参：`{ "video_id": "string (必填,用创建返回的长 video_id)" }`
返回：`{ status, progress, url?(顶层 url 字段), error? }`。
实现：`GET /agnesapi?video_id=<video_id>`;404 视为 `queued`（服务端偶发延迟）。

### 3.4 `get_config` / `set_config`
- `get_config` → 返回脱敏配置（base_url、api_key 掩码、默认模型/尺寸）。
- `set_config` → 写入配置文件（见 §4）。供 AI/调试用;主配置入口仍是面板。

---

## 4. 凭证与配置方案（关键决策）

### 4.1 存储位置
采用 **appConfigDir 下的独立配置文件**：`<appConfigDir>/agnes/config.json`
```json
{
  "base_url": "https://apihub.agnes-ai.com",
  "api_key": "sk-...",
  "image_model": "agnes-image-2.1-flash",
  "video_model": "agnes-video-v2.0",
  "default_size": "1024x1024"
}
```
理由：与 `requirement`/`todo` 一致（`argsTemplate: ['{{appConfigDir}}', ...]`）;面板可编辑;进程重启后持久。

### 4.2 Rust bin 读取
`mcp_config_service.rs` 注册 args 模式用 **`ConfigDirAndWorkspace`**（现有枚举,无需扩展）,bin 首参即 `appConfigDir`,启动时读 `agnes/config.json`;`set_config` 工具写回同文件。
> `McpServerArgsMode` 现有变体：`ConfigDirAndWorkspace` / `WorkspaceOnly` / `AskListener`。选 `ConfigDirAndWorkspace`。api_key 不走命令行参数(避免进程列表泄露),仅走配置文件。

### 4.3 配置写入者（子决策，待定）
面板保存配置的落盘方式，三选一：
- **A（推荐）**：新增轻量 tauri command `agnes_save_config(config)` 写 `agnes/config.json`。清晰、类型安全。
- B：复用现有通用配置写 API（若存在插件级 KV 存储）。零新增命令,但需确认有无现成通道。
- C：前端直接经 fs 插件写文件。最少耦合,但绕过校验。

### 4.4 前端 API 调用的 CORS
面板自身要调 4 个端点（生图/查询等）用于**手动模式**。dev 态浏览器直连会 CORS。方案：面板走 **tauri command 代理**（仿历史 `commands/agnes.rs` 的 reqwest 转发,或复用已有通用 http 代理 `http_request`）。生产 tauri 无 CORS,但统一走代理更稳。
> 记忆参考：历史上正是用 Rust reqwest 代理解决 Agnes dev 态 CORS。

---

## 5. 视频异步方案（UX 关键）

实测：短视频即需 ~100s,长视频 300s+。三层处理：

1. **MCP agent 路径**：`generate_video(wait=true, timeout_sec=300)` 内部阻塞轮询（每 3-5s 一次,带退避）,完成即一次性返回 URL;超时降级返回 `video_id` + 提示用 `query_video` 续查。→ agent 单次调用即得结果,避免多轮手动轮询。
2. **面板手动路径**：面板 `create → 轮询` 自带进度条（`progress` 字段 0-100),异步不阻塞 UI;失败/超时可重试或继续等待。
3. **可恢复性**：`query_video` 独立暴露,任意 `video_id` 可续查,进程/会话中断不丢任务。

轮询实现细节：
- 间隔：首 30s 每 3s,之后每 6s（简单退避,控制请求量）。
- 终止：`completed`/`failed`/超时。
- `404` → 当作 `queued` 继续(创建后短暂延迟)。

---

## 6. 前端面板设计（`AgnesPanel.tsx`）

活动栏图标 `Film`,`order` 建议 50（介于 translate=40 与 requirement=60 之间）。

Tab 结构：
- **生图**：prompt、size 下拉、模式（文生图/图生图）、图生图时上传/粘贴输入图（→ data URI）、输出格式;生成后网格画廊（可下载/复制/发送到聊天）。
- **生视频**：prompt、宽高、时长助手（时长→自动算 `num_frames=8n+1`/`frame_rate`,内置文档推荐档位:3s/5s/10s/18s）、模式（文生/图生/多图/关键帧）、图输入、`seed`/`negative_prompt` 高级项;创建后**进度条 + 轮询**,完成内嵌 `<video>` 播放 + 下载。
- **设置**：base_url、api_key（密码框）、默认模型/尺寸 → 保存到 §4 配置。

复用：`onSendToChat` 回调（`PluginPanelComponent` 已提供）把生成结果 URL 发进主聊天。

---

## 7. 聊天内联展示（二期，可选）

一期：AI 调 MCP 工具返回 URL,由现有消息渲染兜底展示。
二期：取回 `MediaPreviewRenderer.tsx`,注册为 chatBlock,把生图/生视频结果在对话流内联为图片/播放器（对标被回滚提交的能力）。属增强,不阻塞一期上线。

---

## 8. 打包与门控

- **web-only 门控**：新增 tauri command（如 `agnes_save_config`、http 代理）须 `#[cfg(feature="tauri-app")]`,mod.rs re-export 同门控（见记忆 `web-only-tauri-command-gate`）,否则 `--no-default-features` 打包报错。
- **externalBin 打包**：`tauri.conf.json` + `tauri.windows.conf.json` 的 `externalBin` 增加 `target/release/polaris-agnes-mcp`（仿 requirements）。
- **Linux/CI**：Agnes bin 纯 HTTP（reqwest）,无系统库依赖,无需 `cfg(windows)` 门控（区别于 computer-mcp）。

---

## 9. 分阶段实施步骤

**Phase 1 — MCP 后端（可独立验收）**
1. 取回并改写 `agnes_mcp_server.rs`（4 工具,按 §3 接口 + §0 实测字段）。
2. 新增 `polaris_agnes_mcp.rs` bin + `Cargo.toml [[bin]]` + `services/mod.rs`。
3. `mcp_config_service.rs` 注册 builtin（`ConfigDirAndWorkspace`）。
4. `cargo check --lib` + bin 单测（tools/list、8n+1 校验、config 默认值）。
5. 手工：设 `agnes/config.json`,用测试 key 跑 `generate_image`/`generate_video`/`query_video`。

**Phase 2 — 前端插件外壳**
6. `manifest.ts` + `builtinPlugins.ts` 注册 + `Film` 面板懒加载 + i18n。
7. 插件中心可见、可开关,活动栏出现 Agnes 图标。

**Phase 3 — 面板功能**
8. `api.ts`（tauri 代理）+ `AgnesPanel.tsx`（生图/生视频/设置三 Tab + 进度轮询）。
9. `agnes_save_config` command（门控）。
10. 端到端：面板生图出图、生视频出进度并播放、配置持久。

**Phase 4 — 聊天内联（可选增强）**
11. 取回 `MediaPreviewRenderer` 注册 chatBlock。

---

## 10. 测试与验收

- Rust：`cargo check --lib`;bin 单测（工具枚举/参数校验/配置序列化）。
- 前端：`tsc` 零错误、`vite build`、`eslint`;`vitest`（manifest 注册、api 组包函数）。
- E2E（tauri:dev + 测试 key）：
  - [ ] 文生图出 URL;图生图（传输入图）出图。
  - [ ] 文生视频创建→进度→完成播放;图生视频。
  - [ ] `num_frames` 非法值被纠正。
  - [ ] 配置保存后重启仍在。
  - [ ] 插件开关生效（关闭后活动栏隐藏、MCP 工具消失）。
  - [ ] AI 主聊天里调用 `generate_image` 成功返回并展示。

---

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 复用回滚代码携带旧接口 | 中 | 严格按 §0/§3 改写,勿照搬端点 |
| 视频长耗时阻塞 MCP 请求 | 中 | `wait/timeout_sec` 参数 + 面板异步轮询,不做无上限阻塞 |
| api_key 明文落盘 | 低 | 与项目现有密钥存储一致;配置文件权限;返回脱敏 |
| web-only 打包漏门控 | 中 | 所有新 command `#[cfg]`,CI 跑 `--no-default-features` |
| dev 态面板 CORS | 中 | 面板统一走 tauri reqwest 代理 |
| 回滚根因未查明 | 低 | 实施前 `git show be2d7a58` 复核是否编译问题(疑似 4 分钟误撤) |

---

## 12. 待确认决策（实施前）

1. **配置写入方式**：§4.3 的 A/B/C（推荐 A：新增 `agnes_save_config`）。
2. **视频阻塞策略**：接受 `generate_video(wait=true)` 阻塞至多 300s 的 MCP 交互否?或强制 `wait=false` 只返回 id 由面板/agent 轮询?
3. **面板范围**：一期是否含图生图/多图/关键帧全模式,还是先文生图+文生视频,其余二期?
4. **聊天内联**：是否纳入一期,还是先 MCP + 面板,内联留二期?
5. **模型/尺寸**：是否需要用户可改 `image_model`/`video_model`,还是锁定文档固定值?

---

*附：实测样例*
- 图：`agnes-image-2.1-flash` + `size 1024x1024` → `data[0].url`（platform-outputs.agnes-ai.space）。
- 视频：`num_frames 81, frame_rate 24` → `seconds 3.4`, `size 1088x832`, ~100s 完成, 顶层 `url` 为 .mp4 直链（`remixed_from_video_id` 为 `null`）。
