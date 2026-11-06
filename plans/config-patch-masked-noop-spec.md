# cap.config patch 掩码回写豁免（masked no-op）spec

> 日期：2026-11-07 · 来源：设置页 Web 服务开关关不掉（报「section web 不允许字段: token」）
> 所有者：`src-tauri/src/services/router/config_capability.rs`（唯一写入路径，不动前端）

## 1. 背景与根因

设置页 WebTab 保存（开关/端口/主机任一改动）必然失败：

```
未知错误: section web 不允许字段: token（白名单: ["enabled", "host", "port"]）
```

因果链：

1. 读：`cap.config get full` 对 `web.token` 打掩码（`apply_masks` → `mask_value`：
   `"****" + 末4位`），前端 `localConfig.web.token` = `"****29++"`（所有来源均掩码，无例外路径）。
2. 写：WebTab 任何 `updateWeb` 都整对象展开（含掩码 token），`buildPatch` 按顶层 key
   JSON 比较后把整个 `web` 对象送进 patch。
3. 校验：`merge_section_value` 对白名单 section **先全量校验后合并**——`token` 不在
   `["enabled","host","port"]` 白名单 → 整个 patch 拒绝 → 合法的 `enabled:false` 也没落盘。

**性质**：D 阶段摘旧回归。旧 `update_config_patch` 无白名单（token 可写）；cap.config
白名单本身是正确的安全设计（否则掩码字符串会覆盖真 token 烧掉鉴权），缺的是「掩码回写
=未修改」的豁免语义。schema 注释承诺的 token 独立写动作（apply_web）尚未立项，不在本 spec。

## 2. 改动（唯一所有者：`merge_section_value`）

`SectionKind::BoolSet | Object` 分支，白名单校验前增加掩码 no-op 判定：

- 条件：`is_sensitive_field(section, k)` **且** patch 值为字符串 **且**
  `mask_value(现值) == patch 值`（现值缺位按 `""` 取掩码，即 `"****"`）。
- 效果：命中者**跳过白名单校验且不进合并**（掩码字符串绝不落盘，真值原样保留）。
- 未命中的敏感字段（如把 token 改成新值）维持现状：白名单拒绝——token 真实写入
  仍走未来独立动作，本 spec 不开洞。

与既有机制的关系：Remote 顶层透传路径已有 `__POLARIS_MASKED__` 哨兵还原
（`restore_remote_sentinels`），语义同为「掩码回写=保持现值」；本改动把该语义补齐到
白名单合并路径（`web.token` 所有来源都掩码，桌面 WebTab 是最高频受害路径）。

## 3. 验收

1. `merge_section_value(config(web.token="real-token-29++"), "web", {enabled:false, token:"****29++"})`
   → Ok，合并结果 `enabled=false` 且 `token` 保持 `"real-token-29++"`（单测断言）。
2. patch token 为**非掩码新值** → 仍拒绝「不允许字段: token」（单测断言，锁死不开洞）。
3. patch 非法非敏感字段（如 `{foo:1}`）→ 仍拒绝（单测断言）。
4. `cargo check` + `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 全过。
5. 真机冒烟：设置页 Web 服务开关关闭→保存成功、服务停；重新开启→保存成功。

## 4. 边界（明确不做）

- 不放行 token 真实写入（独立动作另立 spec）。
- 不动前端 WebTab（掩码 token 展示与二维码逻辑维持现状）。
- 不动 modelProfiles/providerGroups 透传路径（已有哨兵机制，且不经过本函数）。
