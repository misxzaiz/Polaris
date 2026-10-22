# 无限畅听电台 — P3 实施前评估（边界文档）

> 上游：总纲 `radio-broadcast-infinite-listening-spec.md` §五「P3 生态（打磨，不承诺）」。
> 结论先行：**本轮不实施 P3 任何子项**。本文记录逐项评估依据与重启条件，替代实施。

## 逐项评估

| 项 | 评估 | 结论 |
|---|---|---|
| 双主播对话（句级 speaker 多音色） | 需 AI 输出句级 speaker 标记协议（改协议 = Rust/前端双边同步，且无 schema 校验兜底）+ 播放器 per-sentence 音色路由 + stdio 串行合成成本 ×2。当前句级流水线假定单音色，路由改动波及 player 状态机。 | **不做**。成本/收益比显著劣于 P0-P2 全部已交付项；重启条件：缓存命中率数据证明免费额度可支撑 ×2 成本 |
| 订阅式更新（cron 早报） | 依赖后台调度；而 §6.4 已裁决「预生成 v1 以前台 headless 为界」且 P2 实施时已确认**连前台 headless 预生成都不做**（AI 生成依赖前端会话管道，thead headless 化成本高）。cron 生成是同一约束的更重形态。 | **不做**。重启条件：Rust 侧 tokio 后台会话管道落地后 |
| edge-tts 内置引擎兜底（免 Key） | 需把 mimo-tts 之外的第二条引擎链接入 cap.voice（discover/委托分发/presets 语义/缓存 keyBA 引擎位全要验证）；`ttsService`（edge-tts）目前为只读参考，总纲亦裁决 P1 前不动、未承诺后续接入。 | **不做**。重启条件：出现真实「无 Key 用户」反馈或插件 Key 配置率数据 |
| 车机蓝牙深适配 | 依赖真实车机环境（蓝牙协议栈、 MediaSession 行为差异），无设备无法验证；现有锁屏/媒体会话控制（P0-4）已覆盖常规蓝牙按钮可达。 | **不做**。重启条件：拿到测试设备及复现清单 |
| 多端同步 | 跨设备需要账号体系/服务端存储（当前数据根在本机 localStorage + JSON 文件），超出桌面单机形态。 | **不做**。重启条件：出现多设备用户场景 |

## 已交付能力覆盖度对照（如实）

总纲体验目标与现状：

- 连续不断档播报、字幕跟读、倍速、睡眠定时、锁屏控制 → P0 ✅
- 音色资产库（设计/克隆试听入库）、听过的内容自动沉淀、随时回听（零 API 成本）、合成缓存护城河 → P1 ✅
- 换台不停声、半双工插话、上次畅听一键续播、北极星埋点（metrics 本机累计）→ P2 ✅
- 预生成囤积（总纲 P2-3）与 AI 管家 tools（P2-4）→ 在 P2 子 spec §3 已收敛裁决：**并入 P1/P2 已交付路径，不做独立 headless jobs/工具注入**，理由同上表第二行。

## 埋点查询方式（验收北极星用）

`localStorage['polaris.radioMetrics']`：`{ listenMs, sessionCount, replayCount, switchCount, interjectCount }`。数据可直接回答「用户是否真的在无限畅听、 motor 是否在用回听/换台/插话」。

## 门禁记录（P3 评估轮）

- 未改任何生产代码，无验证负担；前一轮门禁：`tsc` ✅、`pnpm lint` 0 error、`vitest` 4 文件 83 用例全绿、`cargo check` 与 web-only 门控 `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 均 exit=0。
