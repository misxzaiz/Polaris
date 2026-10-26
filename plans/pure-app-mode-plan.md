# 纯 App 模式(Pure App Mode)分析规划

> 状态:**分析规划,未实施**(用户指令 2026-10-25:仅分析规划 + 可交互原型)
> 需求原文:「在入口的连接可以加一个入口进入纯app端,纯app端先只做简单的ai对话就行」「不一致直接用现有前端」
> 上游:`plans/mobile-pure-phone-analysis.md`(解读②=手机完全自包含)、`plans/mobile-self-contained-spike.md`(三道闸门探路,已全部核实)

## 1. 产品定义

**纯 App 模式** = 在现有 MobileConnectionGate(连接桌面/服务器)之外加第二入口,进入**不依赖任何后端**的本地模式:手机上直接进行简单 AI 对话。

```
APK 启动
  ├─ 填 IP+Token 连接后端 → 完整模式(现状,不变)
  └─ 「暂不连接,进入纯App模式」→ 纯模式(新增)
        ├─ 本地配置模型(API Base/Key/Model)
        ├─ 本地会话(增删查,存手机)
        └─ 简单对话(流式)——首版范围到此为止
```

**显式不做**(首版):插件/MCP、工作区/文件树、语音电台(mimo 是后端子进程;浏览器内 edge-tts 前端合成另评估)、调度器、跨端同步、工具调用。

## 2. 架构:双引擎单 UI(关键决策)

用户约束「直接用现有前端」+「先只做简单对话」→ 引擎分两阶段,UI 与数据形态不变,P0 先落地:

### P0 纯前端直连(推荐首版,天级)

```
┌─ APK WebView(现有 SPA,本地加载)──────────────┐
│ Gate 第二入口 → 纯模式路由                     │
│   ├─ 复用:聊天气泡/Markdown/ChatInput/主题     │
│   ├─ 本地对话引擎 LocalChatEngine(新增,前端): │
│   │    fetch + SSE 直连 OpenAI 兼容端点(HTTPS) │
│   │    合成 AIEvent 序列喂现有事件处理(UI 零改) │
│   ├─ 配置:localStorage(apiBase/apiKey/model)   │
│   └─ 会话:复用 dialogStorage 的 OPFSBackend     │
│        (现成!它就是为"后端不可达"设计的离线后端) │
└──────────────────────────────────────────────┘
   手机 ──HTTPS──> LLM 云端(Anthropic/OpenAI/兼容聚合端点)
   不监听任何端口,不跑任何本地服务
```

- **零 Rust 新增逻辑**;但 APK 打包仍需 lib 过 android 编译 → **仍需闸门①(31 错误 cfg 门控,~半天)+ 闸门②(data_root 注入,~10 行)**;**不需要闸门③**(不监听回环明文)。
- **CORS 是主要技术风险**:APK WebView 遵循 CORS,无法用宿主代理绕过。OpenAI/大多数兼容聚合端点放行;Anthropic 需 `anthropic-dangerous-direct-browser-access` header;个别端点会拦——**首版验证清单第一项**(见 §6)。
- **副产品**:同一模式让**已安装的 PWA(手机浏览器)也能离线独立对话**——SW 离线壳(1B 已做)+ 纯前端引擎 = 无 APK 的自包含手机使用。

### P1 内嵌核(=分析报告 C·M1,周级,后续升级)

```
手机进程内跑裁剪后端(SimpleAI+session-v2+axum@127.0.0.1)
WebView 连回环 → 现有 HTTP transport 原样工作
```
- 需闸门①②③全部 + run() 移动分支 + 本机 UI 的 Source::Remote 契约课;换来后端权威架构一致、会话可经"连电脑"迁移、未来工具/插件可扩展。
- **P0→P1 切换面**:LocalChatEngine 与内嵌核都产出同一套 AIEvent;引擎适配器接口(userEngine.send() → AsyncIterable<AIEvent>)双实现,P1 上线即换,UI 不动。

### 为什么不直接 P1

| | P0 纯前端 | P1 内嵌核 |
|---|---|---|
| 到可用 | 天级(用户"先只做简单对话"完全覆盖) | 1-2 周级 |
| Rust 改动 | 仅闸门①②(为打包,非功能) | ①②③+装配+契约课 |
| 架构一致性 | 前端自管会话(与"日志即真相"相悖,但纯模式数据本就只在手机) | 后端权威,与主线一致 |
| 扩展性 | 无工具/插件可能 | 保留全部可能 |
| 风险 | CORS 逐端点验证 | 量级与面大 |

## 3. 入口与信息架构(原型呈现)

- **Screen A 连接 Gate(改)**:现有表单不动;底部加次级入口「暂不连接,进入纯App模式 →」(视觉降级,不抢主路径)。
- **Screen B 纯模式首页(新,轻)**:会话列表(OPFS)+「新对话」+ 设置(模型配置:Base URL/API Key/模型名/连通性测试)+ 顶部「纯App模式」徽标 + 设置内「连接桌面切回完整模式」。
- **Screen C 对话(复用)**:现有聊天气泡/流式/输入条;顶部徽标提示当前模式;标题即会话名。
- 模式切换:Gate 入口选择 + 设置内切换;两模式会话数据**不互通**(存储域不同:OPFS vs 后端),UI 明示。

## 4. 复用清单(「直接用现有前端」的落点)

| 现有资产 | 纯模式复用方式 |
|---|---|
| 聊天渲染(blocks/Markdown/代码块) | 原样 |
| ChatInput(含附件 UI) | 原样,附件首版禁用 |
| `dialogStorage` OPFSBackend/LocalStorageBackend | **原样**(设计初衷就是离线) |
| conversationStore 事件处理(eventHandler) | 经 LocalChatEngine 合成事件驱动,UI 语义不变 |
| 主题/compact 布局 | 原样 |
| ttsService(浏览器内 edge-tts) | APK WebView 为 https 源(tauri.localhost),crypto.subtle 可用,**可保留语音朗读**(待真机验证) |
| MobileConnectionGate | 加第二入口,连接主路径零改动 |

## 5. 限制与安全边界(如实)

- API Key 存 WebView localStorage:与现有 token 同级安全边界;泄漏面=手机本机;不支持 env 引用(前端无 env)。P1 内嵌核后可复用后端 `${ENV}` 掩码机制。
- 纯模式会话**只在本机**:换手机/清数据即失;不可迁移到桌面(除非后续做导出)。
- 无工具/插件/工作区:AI 是纯聊天模型,不能读文件/执行命令。
- 部分供应商端点可能 CORS 拦截(§6 验证清单)。
- 计费/限流直连用户自己的 Key,无网关分组/failover(那是后端能力)。

## 6. 首版验证清单(实施前半天)

1. APK WebView 内对目标端点(OpenAI 兼容/DeepSeek/智谱/Anthropic)逐个 fetch+SSE 连通性(CORS 实测);
2. `crypto.subtle`/edge-tts 在 tauri.localhost 的可用性(语音朗读);
3. OPFS 会话在 Android WebView 的容量/持久性(卸载重装即清,预期内);
4. 闸门①②修复后 APK 可构建(debug 即可,不涉③)。

## 7. 分期

- **Phase PA-0(闸门清障,~1 天)**:闸门①cfg(desktop) 门控 31 错误 + 闸门② data_root 注入;产出可构建的 debug APK。此步与 P1 无关必做。
- **Phase PA-1(P0 纯前端引擎,天级)**:LocalChatEngine + Gate 第二入口 + 设置页 + OPFS 会话接线;CORS 验证清单。
- **Phase PA-2(体验补齐)**:语音朗读验证、会话管理完善、导出。
- **Phase P1(内嵌核,另立 spec)**:报告 C·M1 原案,接口已在 P0 预留。
