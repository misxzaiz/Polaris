# 设置页布局改容器实测宽驱动(修复偶发上下堆叠)

- 日期:2026-11-08
- 所有者:SettingsPage / SettingsSidebar(前端)
- 状态:已实施

## 背景 / 根因

设置页左右/上下布局由 CSS 视口媒体查询决定(`flex-col sm:flex-row`、`sm:w-56`、`sm:flex-col` 等,断点 640px)。用户环境(1920 物理 × Windows 125% 缩放 = CSS 视口 1536)偶发设置页翻成上下堆叠且侧栏为**竖排**——即同一断点的 `sm:` 规则在部分元素上失效、部分生效的混合态。已排除:窗口真窄、DPI 双重应用(1.25² 后视口 1228 ≫ 640)、WebView2 持久缩放(需 ≥250% 且伴随全局字大)。定性为 WebView2 在分数缩放 + 全屏切换下媒体查询评估陈旧/部分失效的渲染器层 bug(已知 bug 类),宿主代码无法修复其评估路径本身。

## 方案

布局决策源从「CSS 媒体查询」换成「**JS 实测容器宽度**」(复用 `hooks/useContainerWidth`,ResizeObserver 读真实布局盒):

- `SettingsPage` 主体容器挂 ref,`wide = width >= 640`(阈值与旧断点一致);容器类名按 `wide` 切 `flex-row` / `flex-col`。
- `SettingsSidebar` 新增 `wide` prop,侧栏横向条/竖栏、搜索框显隐、导航排布全部由该 prop 切换,**删除上述元素上全部 `sm:` 布局类**(唯一权威,避免双路径打架)。
- `useContainerWidth` 增加可选 `initialWidth` 参数(additive,存量调用方不受影响),以 `window.innerWidth` 作首帧初值,避免打开设置页首帧闪堆叠;随后 ResizeObserver 以实测值接管。

为何彻底:ResizeObserver/`clientWidth` 读的是真实盒宽,不经过媒体查询那条会陈旧的评估路径;且缩放、DPI、跨屏任何原因导致的真实变窄都会得到**正确的**响应式行为(真窄 → 真堆叠)。

## 边界

- 仅改 `SettingsPage.tsx` / `SettingsSidebar.tsx` / `useContainerWidth.ts` 三个文件;不新增依赖。
- 标题栏/底栏/内容区的 `sm:px-6 sm:py-4 sm:p-6` 等内边距类**保留**:纯装饰,即使陈旧失效也无功能影响,不值得扩散改动面。
- 不动其他页面的 `sm:` 用法(它们没有暴露同类问题)。

## 验收

1. `pnpm exec tsc --noEmit` 通过;相关 vitest 通过。
2. 新增 `SettingsSidebar` 测试:wide=true 渲染竖栏类(`w-56`/`flex-col`/搜索框可见),wide=false 渲染横条类(`border-b`/搜索框隐藏)。
3. 手工冒烟(用户侧):125% 缩放 + F11 全屏往复,设置页不再翻转;窗口真拖窄(<640)时仍正确堆叠、可横向滚动导航。
