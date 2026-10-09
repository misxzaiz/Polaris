# Sky 前端优化方案 — 手机端优先

> 基于 375x812 (iPhone) 视口多轮对话实测,2026-10-09
> 目标:修复致命布局问题 + 手机端交互舒适 + 多轮对话稳定

---

## 问题清单(按严重度)

### P1 高度链断裂 🔴 致命
- **现状**: `#app` 无 `height:100%`,stream 只有 197px(应 ~711px),composer 漂浮在 297px 处
- **根因**: `html(812) → body(812) → #app(auto=298) → .river(100%=298)` 高度链断裂
- **修复**: `#app { height: 100vh; display: flex; flex-direction: column; }`

### P2 软键盘遮挡输入框 🔴 致命
- **现状**: 无 `visualViewport` 适配,iOS 键盘弹出后 composer 被挡住
- **修复**: 监听 `visualViewport.resize`,动态调整 composer 位置:
  ```js
  window.visualViewport?.addEventListener('resize', () => {
    const offset = window.innerHeight - visualViewport.height;
    document.querySelector('.composer').style.transform = `translateY(${-offset}px)`;
  });
  ```

### P3 发送按钮触摸目标 < 44px 🟡
- **现状**: 40x40px
- **修复**: 改为 44x44px(Apple HIG 最低触摸目标)

### P4 滚动跟滚在触摸设备失效 🟡
- **现状**: `wheel` 事件监听,触摸设备不触发 → 用户上翻看历史时新消息强制拉回底部
- **修复**: 改用 `scroll` 事件 + 判断 `scrollTop` 距底距离:
  ```js
  stream.addEventListener('scroll', () => {
    followBottom = (stream.scrollHeight - stream.scrollTop - stream.clientHeight) < 80;
  });
  ```

### P5 顶栏 hover 在触摸设备不可用 🟡
- **现状**: `mousemove` 触发,触摸设备无 hover → 无法访问 token 设置/浮窗
- **修复**: 加底部浮动菜单按钮(替代 hover 顶栏),或顶部下拉手势

### P6 输入框 font-size:15px 触发 iOS 缩放 🟡
- **现状**: iOS 对 <16px 的 input 会自动缩放页面
- **修复**: `font-size: 16px`(或加 `maximum-scale=1` 但影响无障碍)

### P7 流式超时后空 block 残留 🟡
- **现状**: AI 请求超时/失败后 assistant block 永远显示光标
- **修复**: 加超时(30s 无 chunk → 标记 done + 显示"回复超时")

### P8 代码块长行无水平滚动 🟢
- **现状**: `pre.code` 有 `overflow-x:auto` 但未测试长行
- **修复**: 确认 CSS 有效(已有)

### P9 无空状态 🟢
- **现状**: 首次打开空白
- **修复**: 加欢迎引导("对 Sky 说点什么…")

---

## 修复优先级

1. **P1 高度链** — 1 行 CSS,立即修
2. **P2 软键盘** — visualViewport 监听,手机端核心
3. **P4 滚动跟滚** — scroll 事件替代 wheel
4. **P5 顶栏呼出** — 底部浮动按钮
5. **P3 触摸目标** — 按钮 44px
6. **P6 font-size** — 16px
7. **P7 超时** — 30s guard
8. **P9 空状态** — 欢迎语

---

## 实施顺序(单文件改动,主要是 style.css + render/index.ts)

### A. style.css 修复(P1/P3/P6/P8)
```css
#app { height: 100vh; display: flex; flex-direction: column; }
.composer textarea { font-size: 16px; }
.send { width: 44px; height: 44px; }
```

### B. render/index.ts 修复(P2/P4/P5/P7/P9)
- `boot()` 加 `visualViewport` 监听(P2)
- `autoScroll()` 改用 `scroll` 事件(P4)
- 加底部浮动菜单按钮替代 hover 顶栏(P5)
- `sendInput()` 加 30s 超时 guard(P7)
- 初始空状态渲染(P9)
