# ChatNavigator 悬停展开「消息区闪动」修复

## 问题（2026-10-25 报告）

多轮会话中鼠标碰到右缘对话导航（timeline 圆点列）时，AI 消息区出现闪动，悬浮面板不好用。

## 根因

1. **动画覆盖定位 transform（主因）**：面板单元素同时承担「`top:50% + translateY(-50%)` 垂直居中定位」和「`animate-dialog-in` 入场动画」。动画 keyframes（tailwind.config.js `dialog-in`：`translateY(12px) scale(.94)` → `translateY(0) scale(1)`）在播放期间优先级高于 inline transform，把 `translateY(-50%)` 抹掉：动画期间面板整体偏低半个面板高度（70vh 面板可偏差 300px+），动画结束（fill-mode none）回落 inline transform 时瞬间上跳。
2. **6px 悬停死区**：timeline 触发条 hover 区占 right 2–10px，面板右缘在 right:16px，中间 6px 不属于任何 hover 元素。从圆点移向面板时触发 150ms 隐藏倒计时，慢速移动或被①的面板跳位甩出后面板半途关闭。
3. **`SHOW_DELAY = 0`**：碰到即弹，路过右缘/碰滚动条车道也闪开一次，叠加①②形成「弹出→跳位→关闭→再弹」循环，用户感知为消息区闪动。

## 修复方案（最小改动，仅动 `ChatNavigator.tsx`）

| # | 改动 | 说明 |
|---|---|---|
| 1 | 定位/动画分离 | 面板拆成两层：外层 wrapper 只做 `absolute` 定位（含 `translateY(-50%)` 居中，不动画、悬停事件挂这层保证命中区稳定）；内层面板跑 `animate-dialog-in` + `maxHeight` 约束。keyframes 只作用于内层，不再碰定位 transform。floating / timeline / compact 三种 panelStyle 同步拆分。 |
| 2 | 消除死区 | timeline 面板右缘从 `right:16px` 改 `right:10px`，与触发条 hover 区（right 2–10px）零间隙相接。 |
| 3 | 悬停意图确认 | `SHOW_DELAY` 0 → 250ms；快速掠过不再弹面板。click 切换仍即时。 |

不改共享 `dialog-in` keyframes（Modal/搜索面板等多处复用，它们无 inline 定位 transform，改了反而引入回归）。触发条与滚动条车道的重叠靠③的意图延迟缓解，几何不动。

## 验收

- 悬停圆点 250ms 面板展开，展开位置立即为最终居中位置，动画结束无跳位。
- 从圆点移入面板全程面板不消失；移出触发条+面板 150ms 后关闭。
- 快速掠过右缘（<250ms）面板不弹。
- `pnpm exec tsc --noEmit`、`pnpm lint`、新增 `ChatNavigator.test.tsx` 通过。
