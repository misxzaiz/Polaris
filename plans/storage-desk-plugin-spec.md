# storage-desk 数据与存储管理台插件化 spec

> 日期：2026-11-16 · 状态：实施中
> 流程复制 model-desk/snippet-desk（spec→骨架→主仓瘦身→四门禁→真机→push）。
> 用户定案（2026-11-16）：继续下一步（即本候选）。

## 0. 目标

把 Settings 的 DataStorageCard（753 行，数据根信息/OPFS 迁移/清理）+ ChangeDataRootWizard（458 行，数据根切换向导）迁出为独立插件 **storage-desk**。

## 1. 边界

**迁出**：`Settings/tabs/DataStorageCard.tsx`（753）、`Settings/tabs/ChangeDataRootWizard.tsx`（458）、`services/dataRootService.ts`（246，invoke 走运行时转发 transport，直接拷贝改 import）、`stores/historyPrefsStore.ts`（64，zustand persist 独立）。
**留宿主**：dialogStorage 域（存储引擎，P6 定策）；`utils/platform.ts`（isTauri/isWeb 多处消费，插件 deps 内联同款实现）。
**OPFS 4 函数**（isOpfsMigrated/probeOpfsDialogCount/migrateOpfsToTauri/clearOpfsDialogs）：不拷贝——appCoreBridge 补挂 `opfsHelpers` 对象（一行装配），插件经桥调用。
**Icon**：迁移用 lucide 同名替换（若有简单 SVG 自定义 Icon 一并替换）。

## 2. 数据面（零后端改动）

- 数据根信息/扫描/迁移/切换：`cap.data_root`（dataRootService 已封装）✅
- OPFS 统计/迁移/清理：宿主 opfsHelpers 桥 ✅（本 spec 补挂）
- historyPrefs：zustand persist localStorage，插件内独立实例 ✅

## 3. 主仓瘦身

- SettingsPage：删两组件 import/渲染分支（storage 相关 tab 分支改渲染引导或直接删，按侧栏项同步删）
- SettingsSidebar：删对应导航项（若有）
- appCoreBridge：services 补挂 `opfsHelpers`
- 删文件：`tabs/DataStorageCard.tsx`、`tabs/ChangeDataRootWizard.tsx`、`services/dataRootService.ts`、`stores/historyPrefsStore.ts`
- 保留：dialogStorage 域、utils/platform

## 4. 门禁

插件仓 build+tsc；主仓 tsc/vitest/lint（不新增 error）/cargo check/web-only；grep 断言主仓 0 命中 `DataStorageCard|ChangeDataRootWizard|dataRootService|historyPrefsStore`；真机 9827：activityBar 出现 storage-desk、数据根信息渲染、OPFS 统计、historyPrefs 读写。

## 5. 回滚

禁用插件；revert 主仓删码 commit。
