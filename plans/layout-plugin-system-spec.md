# 可布局面板系统：布局插件 + 插件安装位声明 + 实时渲染

日期：2026-11-16 ｜ 关联：kernel-5k-all-plugin-architecture.md（极简核）、kr4（form/nexus 目录化）

## 需求

1. 支持先安装一个「布局插件」——由它决定宿主的整体面板骨架（左/中/右/底部/浮动层等槽位）。
2. 其他插件安装时**声明安装位置**：left / right / center / bottom / top / overlay / 具体槽位 id。
3. 支持实时渲染：布局变化、插件安装/卸载/启停后，面板树即时更新，无需刷新。

## 现状（已有基础）

- 插件 manifest `contributes.views[]` 已有 `area: 'activityBar' | 'mainSurface'`、`slot`、`slotMode: append|shadow|chain`、`order`。
- `pluginTabRendererRegistry` 已支持插件接管 tab 渲染（chat-desk/files-desk 实证）。
- `CenterStage` 按 tabStore 的 activeTab 渲染；侧栏由 activityBar contributions 驱动。

## 设计

### 1. manifest 契约扩展（contributes.views 增量字段）

```jsonc
{
  "area": "panel",            // 新增 area：panel（内容面板位）
  "panelType": "my-view",
  "layout": {                 // 新增 layout 块
    "position": "right",      // left | right | center | bottom | top | overlay
    "slot": "main.right",     // 可选：精确槽位 id（布局插件定义的槽位树）
    "size": 320,              // 初始宽度/高度 px
    "minSize": 200,
    "order": 10,              // 同槽位排序
    "visible": true
  }
}
```

### 2. 布局插件（layout plugin）

- 一个特殊插件，`contributes.layout` 声明**槽位树**：
  ```jsonc
  { "contributes": { "layout": {
      "root": "split-h",
      "children": [
        { "slot": "main.left", "size": 260 },
        { "slot": "main.center", "children": [ { "slot": "main.center.top" }, { "slot": "main.bottom" } ] },
        { "slot": "main.right", "size": 360 }
      ] } } }
  ```
- 宿主内核不做布局——CenterStage/壳组件读取「当前生效布局」渲染槽位树，槽位里按 contributions 装配插件面板。
- 无布局插件时回退内置默认骨架（现 CenterStage）。

### 3. 实时渲染

- 布局来源 = `layoutStore`（zustand）：
  - `installedPlugins` 变化 → 重算 contributions → 面板树 diff 更新；
  - 布局插件的 `layout.layout` 变化 → 槽位树更新；
  - 用户拖拽/折叠 → 布局插件经 `cap.ui.layout.update` 持久化（存 anchor/插件配置）。
- 面板组件本身已是 React 组件（blob loader），槽位渲染 = `<Component />`，天然实时。
- 安装/卸载/启停事件（现有 plugin.lifecycle 广播）→ layoutStore 重算 → React 重渲染。

### 4. 迁移路径

| 步骤 | 内容 |
|---|---|
| L1 | types 扩展 `area: 'panel'` + `layout` 块 + registry 解析（向后兼容） |
| L2 | `layoutStore` + `LayoutHost` 组件（读槽位树渲染，回退默认骨架） |
| L3 | 布局插件示例（layout-desk）：槽位树声明 + 拖拽/折叠 + 持久化 |
| L4 | 现有 activityBar/mainSurface 贡献映射进槽位树（兼容层） |
| L5 | 热更新联调：安装/卸载/启停实时反映 |

## 风险

- 与现 CenterStage 双轨期：用「无布局插件 → 走旧骨架」开关隔离。
- 槽位树循环/越界：registry 解析时校验（slot 引用必须存在、无环）。
