# BrowserPanel 手机模式重构方案

> 创建时间: 2026-07-27
> 背景: 内置浏览器 BrowserPanel 的手机预览模式（phone mode）当前体验不佳，存在边界错位和内容溢出两个核心问题，导致手机预览不可用。本文档梳理现状问题、根因分析、修复方案和实施路径，供后续开发者参考实施。

---

## 一、现状

BrowserPanel（`src/components/Browser/BrowserPanel.tsx`）新增了手机模式，通过工具栏的 `📱` 按钮切换。核心逻辑：

1. **`getContainerBounds()`** 在手机模式下返回缩小的居中尺寸，传给 `browserSetBounds()` 让 WebView2 视口缩小到手机尺寸
2. **CSS 装饰层**（`.browser-phone-shell-overlay` / `.browser-phone-frame`）用纯 CSS 渲染手机外壳（边框、刘海、Home Indicator），覆盖在 WebView2 上

---

## 二、问题

### 问题 1：边界错位 — WebView2 视口与手机壳 CSS 尺寸不匹配

**现象**：WebView2 渲染的内容与手机外壳边缘不一致，出现错位、溢出或被裁剪。

**根因**：两套独立的尺寸计算体系

| 组件 | 尺寸计算方式 | 坐标体系 | 示例值 |
|------|-------------|---------|-------|
| WebView2 视口 | `getContainerBounds()` 计算 → `browserSetBounds(x,y,width,height)` | 屏幕绝对坐标 | scaled 后 360×780 |
| 手机壳 CSS | `.browser-phone-frame` 的 `width: deviceWidth, height: deviceHeight` | 容器内相对位置（flex 居中） | 原始 390×844 |

两层使用不同的尺寸基准和定位机制，必然不一致。WebView2 视口是缩放后的 `scaledW/scaledH`（如 360×780），手机壳是原始 `deviceWidth/deviceHeight`（如 390×844），尺寸差 30×64px，边缘必然溢出。

### 问题 2：内容溢出 — WebView2 视口外的内容仍然可见

**现象**：手机壳外的区域仍显示 WebView2 内容，且可点击。

**根因**：手机外壳 CSS 装饰层设置了 `pointer-events: none`，点击穿透到 WebView2。而且 WebView2 视口虽然缩小了，但容器仍是全屏的，视口外的内容没有被裁剪。

### 问题 3：状态栏违和

**现象**：手机模式下顶部工具栏仍然铺开 14 个桌面按钮（后退/前进/刷新/URL/讲解/修改/上下文/诊断/AI操作/DevTools/复制/外部），视觉重量大，与手机预览场景不协调。

---

## 三、修复方案

### 3.1 架构变更

将 WebView2 视口与手机壳统一为**一个共享容器**，两者在同一个父元素内，使用相同的坐标系和尺寸。

```
修复前：
  panel
  ├─ WebView2 容器（全屏 absolute inset-0）
  │   └─ browserSetBounds 缩小视口（scaled 360×780）
  └─ 手机壳 CSS 层（flex 居中，raw 390×844）  ← 不同尺寸、不同定位

修复后：
  panel
  └─ 共享容器 phone-wrapper（absolute center）
      ├─ 手机外壳（边框 + 刘海 + Home Indicator）
      └─ WebView2 视口（精确等于内框，390×850）
      └─ overflow: hidden（裁剪溢出）
```

### 3.2 关键实现点

1. **容器尺寸**：`phone-wrapper` 的尺寸 = 设备尺寸 + 边框厚度。通过 CSS `width: min(设备尺寸, 可用空间比例)` + `aspect-ratio` 自动适配。

2. **WebView2 边界**：`browserSetBounds()` 传入的 `(x, y, width, height)` 直接取自 `phone-wrapper.getBoundingClientRect()`，确保精确对齐。WebView2 视口大小等于手机壳内框尺寸（设备尺寸）。

3. **裁剪**：`phone-wrapper` 设置 `overflow: hidden`，裁剪视口外内容。

4. **无 pointer-events: none**：手机外壳的刘海和 Home Indicator 不需要设置 `pointer-events: none`，因为它们位于 shell 内，不会遮挡 WebView2 的可交互区域。

### 3.3 状态栏精简

手机模式下工具栏精简为 8 个核心操作：

- 后退 / 前进 / 刷新 / URL 输入框（保留）
- 手机模式开关（📱，保留）
- 设备选择下拉菜单（保留）
- 旋转按钮（保留）
- 更多操作折叠菜单（⋯，新）— AI 相关功能（讲解/修改/上下文/诊断/AI操作）收进折叠菜单

桌面模式下保持现有全部按钮不变。

### 3.4 调试面板

底部增加独立的 Tab 面板，包含 Console / Network / DOM / 截图四个 Tab。面板与手机预览互不干扰，可折叠展开。数据通过已有的 `browserGetDiagnostics()` 获取，不需要新增后端。

---

## 四、实施路径

### Phase 0：边界对齐（核心修复）

1. 重构渲染结构：`phone-wrapper` 同时包住 shell 和 WebView2 视口
2. `browserSetBounds()` 使用 `phone-wrapper.getBoundingClientRect()`
3. WebView2 视口尺寸精确等于 shell 内框
4. `overflow: hidden` 裁剪溢出
5. 验证手机模式边界完全对齐

### Phase 1：状态栏精简

1. 工具栏增加手机模式条件渲染
2. AI 相关按钮收进「⋯」折叠菜单
3. 验证桌面模式按钮不变

### Phase 2：调试面板

1. 底部增加 Console / Network / DOM / 截图 Tab 面板
2. 集成 `browserGetDiagnostics()` 数据源
3. 面板可折叠

---

## 五、注意事项

1. **`containerRef` 必须是同一个 DOM 元素**：WebView2 绑定到 `containerRef` 的 `getBoundingClientRect()` 位置。切换手机模式时 `containerRef` 不能指向不同的 DOM 节点，否则 WebView2 会重新创建。修复方案中 `containerRef` 仍然指向 WebView2 视口 div，位置通过父容器 `phone-wrapper` 控制。

2. **手机模式切换时同步边界**：`phoneMode`、`deviceWidth`、`deviceHeight` 变化时，需要触发 `syncBounds()` 同步 WebView2 边界。

3. **CSS `aspect-ratio`**：使用 `aspect-ratio: 390 / 850`（设备宽高比）自动保持手机比例，无需手动计算高度。

4. **`overflow: hidden`**：`phone-wrapper` 必须有 `overflow: hidden`，否则 WebView2 视口外的内容仍然可见。

---

## 六、原型参考

- 问题原型：`.polaris-handoff/prototype-problem.html`
- 修复原型：`.polaris-handoff/prototype-fixed.html`

两个原型用 HTML/CSS 模拟了修复前后的视觉差异，标注了尺寸体系差异和修复后的一致性。

