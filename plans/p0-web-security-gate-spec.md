# P0 Web 安全部署闸 spec

> 来源:`plans/mobile-pure-phone-analysis.md`(纯手机端可行性分析)§7 阶段 1A ①②③④⑤⑦。
> 目标:在把 polaris-web 暴露到局域网/公网(方案 A 主线路径)之前,补齐默认配置下的安全缺口。
> 性质:行为改动(安全门控),不动跨进程协议形态;按 AGENTS.md 二.4 先立本 spec 再实现。

## 0. 背景与依据(均为【读码】,行号 2026-10-25 复核)

- 默认配置即高危组合:`host` 默认 `0.0.0.0`、`enabled` 默认 `true`(`models/config.rs` `default_web_host/default_web_enabled`);token 默认 `None` → **API 完全开放**(`web/middleware.rs:115-119`:None/空串直接放行)。
- `/api/files` 跳过中间件、handler 内部鉴权,**不限定根**(`web/api/files.rs` 模块注释与 `normalize_path`):设 token 时持凭据可读全盘任意绝对路径,凭据可走 `?token=` query;未设 token 时匿名全盘读。
- `/api/auth/token` 无任何限速(全 web 目录无 rate limit),可无限次猜 token。
- `cap.config` `get full` 对 **Remote** 返回未脱敏 `modelProfiles[].apiKey` / `providerGroups[].apiKey`(`services/router/config_capability.rs` `do_get` full 分支,脱敏仅覆盖 `web.token`)→ token 泄漏 = 全部 LLM 密钥外流。
- 既有事实(不改动):`md5(token)` 即凭据本体(前端 localStorage 存 md5;`/api/auth/token` 同时接受 raw 与 md5)。

## 1. ① 未设 token 拒绑非回环 + 启动硬告警

**所有者**:`web/server.rs`(单一 choke point `WebServer::start_on_available_port` 与 `WebServer::start`,桌面内嵌与 polaris-web 独立 bin 共用)。

**规则**:
- 定义 `is_loopback_host`:host ∈ {`127.0.0.1`, `localhost`, `::1`, `[::1]`}。
- token 未设置(config.web.token 为 None/空,含 CLI/env 覆盖后仍为空)时:
  - 绑定回环地址 → 允许,但 `tracing::warn!` 硬告警(提示设置 token 才能非回环);
  - 绑定非回环地址 → **拒绝**,返回带修复指引的错误(设置 config.json `web.token` / `POLARIS_WEB_TOKEN` / `--token`)。
- token 已设置 → 不限制。
- **debug 豁免**:`#[cfg(debug_assertions)]` 下仅告警不拒绝(保住 `pnpm tauri:dev:web` 手机局域网联调工作流;与 dev 发现文件同纪律:开发便利不进 release)。
- `run_web_server` 独立 bin 入口把绑定失败从 `.expect`(panic)改为 stderr + `exit(1)`。

**验收**:
- release 构建、无 token、`--host 0.0.0.0` → 进程报错退出,错误信息含修复指引;
- 无 token、`--host 127.0.0.1` → 正常启动 + warn 日志;
- 有 token、`--host 0.0.0.0` → 正常启动;
- debug 构建、无 token、`0.0.0.0` → 启动成功 + warn(桌面 dev 不回归)。

## 2. ③ 登录端点限速

**所有者**:新模块 `web/rate_limit.rs`;接入点 `web/api/auth.rs handle_token_exchange`(唯一"登录"入口;Bearer/WS 校验是常量时间比较、无登录语义,不在本批)。

**规则**(纯 std 实现,不引新依赖):
- 进程内 `Mutex<HashMap<String, Vec<Instant>>>` 单一权威;
- key:优先 `X-Forwarded-For` 首段 IP(反代场景),否则 socket IP(需 `into_make_service_with_connect_info`);解析不出用字面量;
- 限制:**单 key 15 次失败 / 60 秒**;**全局 100 次失败 / 60 秒**(防 XFF 伪造绕过单 key 限制);
- 仅记录**失败的** token 交换;成功即清空该 key 记录;
- 超限返回 `429` + `Retry-After: <秒>`;
- 测试影响:integration_tests 全部失败交换 ≤2 次 < 15,不回归。

**验收**:同 key 第 16 次失败 60s 内 → 429;成功登录后计数清零;不同 key 互不影响。

## 3. ④ cap.config 对 Remote 脱敏 apiKey

**所有者**:`services/router/config_capability.rs`(`invoke` 的 get/patch 分支,`ctx.source()` 可判来源)。

**规则**:
- 哨兵常量 `__POLARIS_MASKED__`;
- **读**:`get full` 当 `Source::Remote` 时,递归掩码 `modelProfiles[]` / `providerGroups[]` 内所有对象的 `apiKey` 字段为哨兵(`web.token` 沿用既有 `mask_value` 不变);`Bootstrap`/`Plugin` 来源保持原文(桌面编辑表单依赖);
- **写**:`patch` 透传路径(modelProfiles/providerGroups 等自由 key)在落盘前,把哨兵 apiKey 按**同数组内 `id` 匹配**还原为现值;`id` 匹配不到 → **拒绝整个 patch**(宁可失败也不把哨兵写进 config 烧掉密钥);新建条目自带真实 apiKey 正常透传;
- **响应**:`patch` 返回的完整 config 对 Remote 同样做读侧掩码(堵"写回响应带出原文"的旁路);
- `get all`/命名 section 不触达这两 section(白名单机制既有保证),不改。

**验收**:Remote `get full` 无任何明文 apiKey;Remote patch 改名称字段不破坏密钥;Remote patch 带未知 id 的哨兵 → 报错;Bootstrap 全流程不变。

## 4. ② /api/files 根白名单

**所有者**:`web/api/files.rs`。

**允许根**(并集,全部规范化后前缀匹配):
1. `data_root().root()` —— 会话附件、语音电台音频、插件资源等全部合法预览源;
2. `config.workspaces[].path` —— 文件浏览器预览的合法来源(`buildFilePreviewUrl` 的实际调用面:ImagePreview/VideoPreview/voiceBroadcast)。

**规则**:
- 既有 `normalize_path`(拒 `..`)保持第一道防线;
- 新增第二道:请求路径与所有允许根各自 `std::fs::canonicalize`(文件已存在,canonicalize 可用;同时消解 Windows 大小写与符号链接歧义)后 `starts_with` 判定;
- 不在白名单 → `403`(区别于 404,可诊断);根目录不存在/不可规范化 → 跳过该根;
- 桌面端不受影响(桌面走 `asset://`,不经此路由);
- 已知收窄:未注册为工作区的任意磁盘路径预览从"可读"变 403——这是本闸的目的;若后续出现新的合法来源(如临时目录导出),按本 spec 追加根,不开例外。

**验收**:白名单内文件 200;`C:\Windows\...`、`~/.ssh/*` 等白名单外 403;穿越路径仍 400/404;workspace 子路径 200。

## 5. ⑤ 反代感知 —— 核实结论:无 Rust 侧代码缺口,交付部署配方

核实过程(2026-10-25):
- 前端 WS URL 由 `location.origin` 派生(`httpTransport.ts` `replace(/^http/,'ws')`),https 反代自动得 wss;
- `isSecureContext` 由浏览器按页面 origin scheme 判定,https 反代即安全上下文(麦克风/相机可用),无需服务端参与;
- 移动端配对二维码是**扫码器**(html5-qrcode)不是生成器,配对 URL 来自用户手填/系统分享,不经过服务端生成;
- 服务端仅有的绝对 URL 生成:`WebServerStatus.url`(本机展示用)与 dev 发现文件(debug-only),均无需反代感知。

**结论**:⑤ 不需要代码改动,交付物为本节部署配方。

**TLS 反代部署配方(阶段 0 实测用)**:
```
# Caddy(Caddyfile)—— 自动 HTTPS + 反代感知头
polaris.example.com {
    reverse_proxy 127.0.0.1:9830
}
# polaris-web 侧绑定回环:POLARIS_WEB_TOKEN=... polaris-web --host 127.0.0.1
```
- 反代注入 `X-Forwarded-For/Proto`;服务端限速(§2)识别 XFF 首段作为客户端 key;
- 不暴露原始端口;`/api/files` 的 `?token=` query 会进反代访问日志 —— 高敏感部署建议改用浏览器扩展注入 header 或接受该残留风险(已知取舍,记录在案);
- Tailscale 替代方案:`tailscale serve` 提供合法证书,免公网暴露,手机装 Tailscale 后按 tailscale 域名访问(报告 §6 选民 2 建议的个人最短路径)。

## 6. ⑦ 备份/导出验收标准(spec 级,实现另立)

数据面唯一权威 = 数据根(`data_root()`);会话双写(JSONL+SQLite)收敛是独立工作项(分析报告 1A⑥),不在本批。以下为**验收场景**(进入实施前必须可回答"怎么做、多久、丢什么"):

1. **服务器到期/被封**:数据根整体拷贝(停机或冷拷贝)→ 新机 `POLARIS_DATA_ROOT` 指向副本启动 → 会话/配置/语音资产完整。验收:演练一次跨机迁移,消息数与配置键数对账一致。
2. **手机丢失**:手机侧零持久化(方案 A 形态)→ 换手机重新输入 URL+token 即恢复全部能力。验收:清除浏览器存储后重新配对,历史经 dialog_index.db 完整恢复。
3. **token 泄漏**:更换 `config.web.token` → 所有旧凭据(md5 形态)立即失效;审计能定位泄漏后发生的 Remote 操作(现存缺口:audit source 仅 "Remote"、device_id 恒字面量——归因贯通列入开放问题,不阻塞本闸)。验收:换 token 后旧 Bearer/旧 ?token= 一律 401。
4. **备份纪律**:数据根内需定期备份的子集 = `config.json`、`*.db`、`dialog JSONL`;可再生的 = `cache/`、`logs/`。验收文档化到部署手册(阶段 2)。

## 7. 实施清单

| 项 | 文件 | 性质 |
|---|---|---|
| ① | `web/server.rs` + `lib.rs`(exit 1)+ `models/config.rs`(修正误导注释"None → 首次启动自动生成",实际无自动生成) | 行为 |
| ③ | `web/rate_limit.rs`(新)+ `web/api/auth.rs` + `web/server.rs`(connect_info)+ `web/mod.rs` | 行为 |
| ④ | `services/router/config_capability.rs` | 行为(权限面) |
| ② | `web/api/files.rs` | 行为(权限面) |
| ⑤ | 本 spec §5(无代码) | 文档 |
| ⑦ | 本 spec §6(验收标准) | 文档 |

**验证命令**:`cargo check`;`cargo check --no-default-features --bin polaris-web --bin polaris-mcp`(命令门控);本机 smoke test(release 或 debug 行为差异按 §1 验收)。

## 8. 实施记录(2026-10-25)

**编译验证**:`cargo check` 0 error(无新增 warning;存量 dead-code `SectionKind::ReadOnly`/`is_sensitive_field` 为审计前已有);`cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 通过;`cargo clippy --lib` 对新改文件 0 新增 warning。

**单测**(随库编译;本机 `cargo test --lib` 受 Tauri DLL 限制不可运行,按 AGENTS.md 以 check + smoke 代替):`decide_bind` 决策矩阵 7 例、`rate_limit` key 提取 3 例、`mask_remote_secrets`/`restore_remote_sentinels` 往返 6 例、`is_path_allowed` 白名单 1 例。

**Smoke test(本机 Windows,隔离数据根)**:
- ③ 限速:合法交换 200 → 15 次错 token 全 401 → 第 16 次 **429 + `retry-after: 57`** ✓
- ② 白名单:数据根内文件 200;白名单外(temp 兄弟路径、`C:/Windows/win.ini`)403;无 token 401;穿越 404;内容原样输出 ✓。踩坑修复:Windows canonicalize 产生 `\\?\` 前缀,根未规范化导致 starts_with 恒 false——两侧统一 canonicalize 后通过
- ④ 脱敏(HTTP 端到端,Source::Remote):patch 真实密钥 ok → `get full` 返回 `__POLARIS_MASKED__` → 带哨兵改名回写 ok → **落盘 config.json 中 apiKey 仍为原文 `sk-live-secret-999`、名称更新生效**;未知 id 哨兵 → 拒绝并附指引;patch 响应同样掩码 ✓
- ① 绑定闸:debug + 无 token + `0.0.0.0` → 启动成功 + 豁免告警 ✓;**release** 构建(19m11s)+ 无 token + `0.0.0.0` → ERROR + stderr + **exit 1** ✓;release + 无 token + `127.0.0.1` → 启动 + 回环告警 ✓

**实施中发现的既有行为(记录,不在本批修)**:`POLARIS_WEB_TOKEN` env 覆盖声明"仅内存不持久化",但任何 config patch 会把**含覆盖值的完整 config 落盘**——smoke 中 env token 被持久化进了 config.json。后续 token 语义改造(如有)需一并处理;运维口径:env 覆盖过的实例落盘配置后 token 即固定。

**遗留**:⑥ JSONL 双写收敛 + device_id 真实化(独立 spec);1B PWA/推送;阶段 0 Linux 真机实测(release 产物 + 手机);阶段 2 触屏/权限档/机器人接 web 桥。
