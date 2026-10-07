/**
 * Web Shell — AI-first 极简对话壳 (v2 原型)
 *
 * 设计 (plans/ai-first-rebuild.md):
 * - 对话是唯一常驻 UI: 顶栏 + 消息流 + 输入区, 手机优先
 * - 会话管理 = 内置极简抽屉 (新建/切换/重命名/删除)
 * - 一切页面级 UI 由 AI 经 cap.ui.window 渲染 (桌面悬浮窗 / 手机底部抽屉, 双形态)
 * - AI 内联卡片经 cap.ui.component (mountPoint: inline) 渲染进对话流
 * - 设置 = 极简兜底 sheet (AI 配置/主题/认证/存储/关于)
 * - 停止生成 / 欢迎屏 / 工具活动卡 / 流式 Markdown + 代码高亮
 * - 手机加固: visualViewport 键盘、重连退避 + 心跳 + 重连后状态恢复、PWA
 *
 * 模板转义铁律 (三层: TS模板→服务端字节→浏览器):
 * - 内嵌 JS 里的正则字面量: 每个 \ 写成 \\
 * - 内嵌 JS 字符串里的 \n / \ 等转义: 写成 \\n / \\\\
 * - 禁止 ${ 与 反引号 出现在内嵌代码里 (字符串拼接)
 */

export const SHELL_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="theme-color" content="#0d1117">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Sky</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  :root {
    --safe-top: env(safe-area-inset-top, 0px);
    --safe-bottom: env(safe-area-inset-bottom, 0px);
    --kb-offset: 0px;
  }
  html, body { height: 100%; }
  body {
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: var(--sky-bg, #0d1117); color: var(--sky-text, #c9d1d9);
    overflow: hidden; overscroll-behavior: none;
  }
  button { font-family: inherit; cursor: pointer; }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }

  #sky-root {
    display: flex; flex-direction: column;
    height: calc(100dvh - var(--kb-offset));
    transition: height 0.05s;
  }

  /* ============ 顶栏 ============ */
  #topbar {
    flex-shrink: 0; display: flex; align-items: center; gap: 6px;
    padding: calc(var(--safe-top) + 6px) 8px 6px;
    background: var(--sky-bg-elevated, #161b22);
    border-bottom: 1px solid var(--sky-border, #21262d);
  }
  #topbar .title { font-weight: 700; font-size: 15px; margin-right: 2px; }
  #topbar .spacer { flex: 1; }
  .tb-btn {
    display: flex; align-items: center; justify-content: center;
    width: 38px; height: 38px; border-radius: 8px;
    background: none; border: none; color: var(--sky-text-muted, #8b949e);
  }
  .tb-btn:hover, .tb-btn:active { color: var(--sky-text, #c9d1d9); background: rgba(255,255,255,0.06); }
  #cap-badge {
    font-size: 11px; color: var(--sky-text-muted, #8b949e);
    background: var(--sky-bg, #0d1117); padding: 3px 9px; border-radius: 10px; white-space: nowrap;
  }

  /* ============ 会话抽屉 ============ */
  #drawer-backdrop {
    position: fixed; inset: 0; z-index: 40; background: rgba(0,0,0,0.5);
    opacity: 0; pointer-events: none; transition: opacity 0.2s;
  }
  #drawer-backdrop.show { opacity: 1; pointer-events: auto; }
  #drawer {
    position: fixed; top: 0; left: 0; bottom: 0; z-index: 41;
    width: min(84vw, 320px);
    background: var(--sky-bg-elevated, #161b22);
    border-right: 1px solid var(--sky-border, #21262d);
    transform: translateX(-102%); transition: transform 0.22s ease;
    display: flex; flex-direction: column;
    padding-top: var(--safe-top); padding-bottom: var(--safe-bottom);
  }
  #drawer.open { transform: translateX(0); }
  .drawer-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 12px 8px;
  }
  .drawer-head .d-title { font-size: 13px; font-weight: 600; color: var(--sky-text-muted, #8b949e); letter-spacing: 1px; }
  .btn-new {
    margin: 0 12px 8px; padding: 10px; border-radius: 8px;
    background: var(--sky-accent, #58a6ff); color: #fff; border: none;
    font-size: 14px; font-weight: 600;
    display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px;
  }
  .btn-new:active { filter: brightness(0.9); }
  #sess-list { flex: 1; overflow-y: auto; padding: 4px 8px 12px; }
  .sess-item {
    display: flex; align-items: center; gap: 6px;
    padding: 10px 10px; margin-bottom: 4px; border-radius: 8px;
    cursor: pointer; min-height: 48px;
  }
  .sess-item:hover, .sess-item:active { background: rgba(255,255,255,0.05); }
  .sess-item.active { background: rgba(88,166,255,0.13); }
  .sess-item .s-info { flex: 1; overflow: hidden; }
  .sess-item .s-title { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sess-item .s-meta { font-size: 11px; color: var(--sky-text-muted, #8b949e); margin-top: 1px; }
  .sess-item .s-act {
    display: flex; gap: 2px; flex-shrink: 0;
  }
  .sess-item .s-act button {
    width: 30px; height: 30px; border: none; border-radius: 6px;
    background: none; color: var(--sky-text-muted, #8b949e);
    display: flex; align-items: center; justify-content: center;
  }
  .sess-item .s-act button:hover { color: var(--sky-text, #c9d1d9); background: rgba(255,255,255,0.08); }
  .sess-item .s-act button.del:hover { color: var(--sky-danger, #f85149); }

  /* ============ 对话区 ============ */
  #stage { flex: 1; display: flex; flex-direction: column; overflow: hidden; position: relative; }
  #scroll {
    flex: 1; overflow-y: auto; overscroll-behavior: contain;
    padding: 14px 14px 6px;
    display: flex; flex-direction: column; gap: var(--chat-gap, 10px);
  }
  @media (min-width: 700px) {
    #scroll { padding: 20px 16px 8px; }
    #scroll > * { width: 100%; max-width: 820px; margin: 0 auto; }
  }

  /* 欢迎屏 */
  #welcome { margin: auto; text-align: center; padding: 24px 8px; }
  #welcome .w-logo { margin-bottom: 14px; }
  #welcome h1 { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
  #welcome p { font-size: 13px; color: var(--sky-text-muted, #8b949e); margin-bottom: 22px; line-height: 1.7; }
  .w-chips { display: flex; flex-direction: column; gap: 8px; max-width: 420px; margin: 0 auto; }
  .w-chip {
    padding: 12px 14px; border-radius: 10px; min-height: 44px;
    background: var(--sky-bg-elevated, #161b22); border: 1px solid var(--sky-border, #21262d);
    color: var(--sky-text, #c9d1d9); font-size: 13.5px; text-align: left;
    display: flex; align-items: center; gap: 8px;
  }
  .w-chip:hover, .w-chip:active { border-color: var(--sky-accent, #58a6ff); }
  .w-chip .chip-ic { color: var(--sky-accent, #58a6ff); flex-shrink: 0; display: flex; }

  /* 消息 */
  #messages { display: flex; flex-direction: column; gap: var(--chat-gap, 10px); }
  .msg { max-width: var(--msg-assistant-maxw, 100%); word-break: break-word; font-size: var(--chat-fontsize, 15px); }
  .msg.user {
    align-self: flex-end;
    background: linear-gradient(135deg, var(--sky-accent, #58a6ff), color-mix(in srgb, var(--sky-accent, #58a6ff) 78%, #000));
    color: #fff;
    padding: 10px 14px; border-radius: 16px 16px 4px 16px;
    max-width: var(--msg-user-maxw, 85%);
    box-shadow: 0 2px 8px rgba(0,0,0,0.25);
  }
  .msg.assistant { align-self: flex-start; padding: 2px 2px; line-height: 1.62; }
  .msg.assistant p { margin: 0 0 8px; }
  .msg.assistant p:last-child { margin-bottom: 0; }
  .msg.assistant code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.88em; background: rgba(110,118,129,0.25); padding: 1.5px 5px; border-radius: 5px;
  }
  .codeblock {
    background: var(--sky-bg, #0d1117); border: 1px solid var(--sky-border, #21262d);
    border-radius: 10px; overflow: hidden; margin: 8px 0;
  }
  .code-lang {
    padding: 6px 12px 5px; font-size: 10.5px; color: var(--sky-text-muted, #8b949e);
    text-transform: uppercase; letter-spacing: 0.6px;
    display: flex; justify-content: space-between; align-items: center;
  }
  .msg.assistant pre {
    background: none; border: none; border-top: 1px solid var(--sky-border, #21262d);
    padding: 12px 12px; overflow-x: auto; margin: 0; position: relative;
  }
  .msg.assistant pre code {
    background: none; padding: 0; font-size: 12.5px; line-height: 1.6; display: block;
    white-space: pre;
  }
  .msg.assistant strong { font-weight: 700; }
  .msg .copy-btn {
    padding: 2px 8px;
    font-size: 11px; border-radius: 5px; border: 1px solid var(--sky-border, #21262d);
    background: none; color: var(--sky-text-muted, #8b949e);
  }
  .hl-c { color: #8b949e; font-style: italic; }
  .hl-k { color: #ff7b72; }
  .hl-n { color: #79c0ff; }
  .msg-note { align-self: center; font-size: 12px; color: var(--sky-text-muted, #8b949e); background: rgba(255,255,255,0.04); padding: 4px 12px; border-radius: 10px; }
  .msg-actions { align-self: flex-start; }
  .regen-btn {
    display: flex; align-items: center; gap: 5px;
    padding: 4px 10px; min-height: 30px; border-radius: 8px;
    background: none; border: 1px solid var(--sky-border, #21262d);
    color: var(--sky-text-muted, #8b949e); font-size: 12px;
  }
  .regen-btn:hover { color: var(--sky-text, #c9d1d9); border-color: var(--sky-text-muted, #8b949e); }
  .msg.typing::after {
    content: "▍"; color: var(--sky-accent, #58a6ff); animation: blink 0.9s infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }

  /* 工具活动卡 */
  .tool-card {
    align-self: stretch; font-size: 12.5px;
    background: var(--sky-bg-elevated, #161b22);
    border: 1px solid var(--sky-border, #21262d); border-radius: 10px;
    overflow: hidden;
  }
  .tool-card .t-head {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 10px; cursor: pointer; min-height: 34px;
  }
  .tool-card .t-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--sky-accent, #58a6ff); }
  .tool-card.run .t-dot { animation: pulse 1s infinite; }
  .tool-card.ok .t-dot { background: #3fb950; animation: none; }
  .tool-card.err .t-dot { background: var(--sky-danger, #f85149); animation: none; }
  @keyframes pulse { 50% { opacity: 0.3; } }
  .tool-card .t-name { font-weight: 600; color: var(--sky-text, #c9d1d9); flex-shrink: 0; }
  .tool-card .t-args { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tool-card .t-ms { flex-shrink: 0; font-size: 11px; }
  .tool-card .t-chev { flex-shrink: 0; transition: transform 0.15s; opacity: 0.6; display: flex; }
  .tool-card.open .t-chev { transform: rotate(180deg); }
  .tool-card .t-detail { display: none; border-top: 1px solid var(--sky-border, #21262d); padding: 8px 10px; }
  .tool-card.open .t-detail { display: block; }
  .tool-card .t-detail .td-label { font-size: 10.5px; color: var(--sky-text-muted, #8b949e); text-transform: uppercase; letter-spacing: 0.5px; margin: 4px 0 3px; }
  .tool-card .t-detail pre {
    background: var(--sky-bg, #0d1117); border-radius: 6px; padding: 8px 10px;
    font-size: 11.5px; line-height: 1.5; overflow-x: auto; white-space: pre-wrap; word-break: break-all;
    max-height: 220px; overflow-y: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  /* 思考链卡片 */
  .think-card {
    align-self: stretch; font-size: 12px;
    background: rgba(255,255,255,0.03);
    border: 1px dashed var(--sky-border, #21262d); border-radius: 10px;
    overflow: hidden;
  }
  .think-card .think-head {
    display: flex; align-items: center; gap: 8px; padding: 6px 10px;
    cursor: pointer; color: var(--sky-text-muted, #8b949e);
  }
  .think-card .think-label { flex: 1; text-align: left; }
  .think-card .think-chev { display: flex; transition: transform 0.15s; opacity: 0.6; }
  .think-card.open .think-chev { transform: rotate(180deg); }
  .think-card .think-body {
    display: none; padding: 4px 12px 10px 26px; max-height: 200px; overflow-y: auto;
    color: var(--sky-text-muted, #8b949e); font-style: italic; line-height: 1.6;
    white-space: pre-wrap; word-break: break-word;
  }
  .think-card.open .think-body { display: block; }

  /* 输入区 */
  #composer {
    flex-shrink: 0; display: flex; align-items: flex-end; gap: 8px;
    padding: 8px 10px calc(var(--safe-bottom) + 8px);
    background: var(--sky-bg-elevated, #161b22);
    border-top: 1px solid var(--sky-border, #21262d);
  }
  @media (min-width: 700px) { #composer { padding-left: calc((100% - 820px) / 2); padding-right: calc((100% - 820px) / 2); } }
  #input {
    flex: 1; resize: none; border: 1px solid var(--sky-border, #21262d);
    background: var(--sky-bg, #0d1117); color: var(--sky-text, #c9d1d9);
    border-radius: 12px; padding: 10px 13px; font: inherit; font-size: 15px;
    max-height: 132px; min-height: 44px; outline: none; line-height: 1.45;
  }
  #input:focus { border-color: var(--sky-accent, #58a6ff); }
  #send-btn {
    width: 44px; height: 44px; border-radius: 12px; border: none; flex-shrink: 0;
    background: var(--sky-accent, #58a6ff); color: #fff;
    display: flex; align-items: center; justify-content: center;
  }
  #send-btn:disabled { opacity: 0.45; }
  #send-btn.stop { background: var(--sky-danger, #f85149); }

  /* ============ 底部抽屉 (sheet) — 手机窗口形态 / 设置 ============ */
  #sheet-backdrop {
    position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,0.55);
    opacity: 0; pointer-events: none; transition: opacity 0.2s;
  }
  #sheet-backdrop.show { opacity: 1; pointer-events: auto; }
  #sheet {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 61;
    max-height: 86dvh; display: flex; flex-direction: column;
    background: var(--sky-bg-elevated, #161b22);
    border-radius: 16px 16px 0 0;
    border: 1px solid var(--sky-border, #21262d); border-bottom: none;
    visibility: hidden; pointer-events: none;
    transform: translateY(100%);
    transition: transform 0.24s ease, visibility 0s 0.24s;
    padding-bottom: var(--safe-bottom);
  }
  #sheet.show {
    visibility: visible; pointer-events: auto;
    transform: translateY(0);
    transition: transform 0.24s ease, visibility 0s;
  }
  @media (min-width: 700px) {
    #sheet {
      left: 50%; right: auto; bottom: auto; top: 50%;
      width: min(560px, 92vw); max-height: 84dvh;
      transform: translate(-50%, -50%) scale(0.96); opacity: 0; border-radius: 14px;
      transition: transform 0.18s ease, opacity 0.18s, visibility 0s 0.18s;
      border-bottom: 1px solid var(--sky-border, #21262d);
    }
    #sheet.show {
      visibility: visible; pointer-events: auto;
      transform: translate(-50%, -50%) scale(1); opacity: 1;
      transition: transform 0.18s ease, opacity 0.18s, visibility 0s;
    }
  }
  .sheet-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 16px 10px; flex-shrink: 0;
  }
  .sheet-head .sh-title { font-size: 15px; font-weight: 700; }
  .sheet-head .sh-close {
    width: 32px; height: 32px; border: none; border-radius: 8px;
    background: none; color: var(--sky-text-muted, #8b949e);
    display: flex; align-items: center; justify-content: center;
  }
  .sheet-body { overflow-y: auto; padding: 0 16px 18px; }

  /* 设置内容 */
  .set-sec { margin-bottom: 18px; }
  .set-sec h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.8px; color: var(--sky-text-muted, #8b949e); margin-bottom: 8px; }
  .field { margin-bottom: 10px; }
  .field label { display: block; font-size: 12px; color: var(--sky-text-muted, #8b949e); margin-bottom: 4px; }
  .field input, .field select {
    width: 100%; padding: 9px 11px; font-size: 14px; min-height: 42px;
    background: var(--sky-bg, #0d1117); color: var(--sky-text, #c9d1d9);
    border: 1px solid var(--sky-border, #21262d); border-radius: 8px; outline: none;
  }
  .field input:focus { border-color: var(--sky-accent, #58a6ff); }
  .btn {
    padding: 10px 14px; min-height: 42px; border-radius: 8px; border: none;
    background: var(--sky-accent, #58a6ff); color: #fff; font-size: 14px; font-weight: 600;
  }
  .btn.secondary { background: var(--sky-bg, #0d1117); border: 1px solid var(--sky-border, #21262d); color: var(--sky-text, #c9d1d9); font-weight: 400; }
  .status { font-size: 12.5px; margin-top: 6px; min-height: 16px; }
  .status.ok { color: #3fb950; }
  .status.err { color: var(--sky-danger, #f85149); }
  .ws-opt {
    display: flex; align-items: flex-start; gap: 9px; padding: 10px 12px;
    border: 1px solid var(--sky-border, #21262d); border-radius: 8px; margin-bottom: 6px;
    cursor: pointer; font-size: 13.5px;
  }
  .ws-opt.active { border-color: var(--sky-accent, #58a6ff); background: rgba(88,166,255,0.08); }
  .ws-opt input { accent-color: var(--sky-accent, #58a6ff); margin-top: 3px; }
  .ws-opt > span { display: flex; flex-direction: column; overflow: hidden; }
  .ws-opt .ws-opt-root { font-size: 11px; color: var(--sky-text-muted, #8b949e); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tray-item {
    display: flex; align-items: center; gap: 8px; padding: 10px 12px; margin-bottom: 8px;
    border: 1px solid var(--sky-border, #21262d); border-radius: 10px;
  }
  .tray-item .tray-info { flex: 1; overflow: hidden; }
  .tray-item .tray-title { font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tray-item .btn { padding: 6px 10px; min-height: 34px; font-size: 12px; width: auto; }
  .theme-chip {
    display: inline-block; padding: 8px 14px; margin: 0 6px 6px 0; border-radius: 8px;
    background: var(--sky-bg, #0d1117); border: 1px solid var(--sky-border, #21262d);
    color: var(--sky-text, #c9d1d9); font-size: 13px; min-height: 38px;
  }
  .theme-chip.active { border-color: var(--sky-accent, #58a6ff); color: var(--sky-accent, #58a6ff); }

  /* ============ 桌面悬浮窗 ============ */
  #win-layer { position: fixed; inset: 0; z-index: 50; pointer-events: none; }
  .win {
    position: absolute; pointer-events: auto;
    background: var(--sky-bg-elevated, #161b22);
    border: 1px solid var(--sky-border, #21262d); border-radius: 12px;
    box-shadow: 0 16px 48px rgba(0,0,0,0.5);
    display: flex; flex-direction: column; overflow: hidden;
    min-width: 280px; min-height: 180px;
  }
  .win-head {
    display: flex; align-items: center; gap: 8px; flex-shrink: 0;
    padding: 9px 10px 9px 14px; cursor: grab; user-select: none;
    background: rgba(255,255,255,0.03); border-bottom: 1px solid var(--sky-border, #21262d);
  }
  .win-head .w-title { flex: 1; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .win-head .w-close {
    width: 28px; height: 28px; border: none; border-radius: 6px;
    background: none; color: var(--sky-text-muted, #8b949e);
    display: flex; align-items: center; justify-content: center;
  }
  .win-head .w-close:hover { color: var(--sky-text, #c9d1d9); background: rgba(255,255,255,0.08); }
  .win-body { flex: 1; overflow: auto; padding: 12px; }

  /* toast */
  #toast {
    position: fixed; left: 50%; bottom: calc(var(--safe-bottom) + 76px); z-index: 90;
    transform: translateX(-50%) translateY(8px);
    background: rgba(30,36,44,0.96); color: var(--sky-text, #c9d1d9);
    padding: 9px 16px; border-radius: 10px; font-size: 13px;
    border: 1px solid var(--sky-border, #21262d);
    opacity: 0; pointer-events: none; transition: opacity 0.2s, transform 0.2s;
    max-width: 86vw; text-align: center;
  }
  #toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

  /* ============ 认证登录层 ============ */
  #auth-overlay {
    position: fixed; inset: 0; z-index: 100;
    background: rgba(0,0,0,0.75); backdrop-filter: blur(4px);
    display: none; align-items: center; justify-content: center;
  }
  #auth-overlay.show { display: flex; }
  .auth-card {
    background: var(--sky-bg-elevated, #161b22);
    border: 1px solid var(--sky-border, #21262d);
    border-radius: 12px; padding: 28px; width: min(420px, calc(100vw - 32px));
    box-shadow: 0 16px 48px rgba(0,0,0,0.5);
  }
  .auth-card h2 { margin: 0 0 8px; font-size: 17px; }
  .auth-card p { margin: 0 0 16px; font-size: 13px; line-height: 1.6; color: var(--sky-text-muted, #8b949e); }
  .auth-card input {
    width: 100%; padding: 10px 12px; margin-bottom: 12px;
    background: var(--sky-bg, #0d1117); color: var(--sky-text, #c9d1d9);
    border: 1px solid var(--sky-border, #21262d); border-radius: 8px; font-size: 13px;
  }
  .auth-card input:focus { outline: none; border-color: var(--sky-accent, #58a6ff); }
  .auth-card .btn { width: 100%; }

  /* 内联 AI 组件 */
  .inline-host { align-self: stretch; }
  .inline-host:empty { display: none; }
</style>
</head>
<body>
<div id="sky-root">
  <div id="topbar">
    <button class="tb-btn" id="tb-menu" title="会话"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg></button>
    <span class="title">Sky</span>
    <span class="spacer"></span>
    <span id="cap-badge">...</span>
    <button class="tb-btn" id="tb-wins" title="窗口管理" style="display:none;position:relative"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg><span id="win-count" style="position:absolute;top:2px;right:2px;background:var(--sky-accent,#58a6ff);color:#fff;font-size:9px;min-width:14px;height:14px;border-radius:7px;display:flex;align-items:center;justify-content:center">0</span></button>
    <button class="tb-btn" id="tb-settings" title="设置"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
  </div>

  <div id="drawer-backdrop"></div>
  <div id="drawer">
    <div class="drawer-head">
      <span class="d-title">会话</span>
      <button class="tb-btn" id="drawer-close" style="width:32px;height:32px"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
    </div>
    <button class="btn-new" id="btn-new"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 5v14M5 12h14"/></svg>新会话</button>
    <div id="sess-list"></div>
  </div>

  <div id="stage">
    <div id="scroll">
      <div id="welcome">
        <div class="w-logo"><svg width="52" height="52" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#161b22"/><path d="M256 88l42 104 104 42-104 42-42 104-42-104-104-42 104-42z" fill="#58a6ff"/></svg></div>
        <h1>Sky</h1>
        <p>AI 对话即全功能。<br>所有页面由 AI 现场渲染, 说出你想要的。</p>
        <div class="w-chips" id="w-chips"></div>
      </div>
      <div id="messages"></div>
      <div id="inline-host" class="inline-host"></div>
    </div>
    <div id="composer">
      <textarea id="input" rows="1" placeholder="说出你想要的..." enterkeyhint="send"></textarea>
      <button id="send-btn" title="发送"><svg id="ic-send" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/></svg><svg id="ic-stop" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="display:none"><rect x="5" y="5" width="14" height="14" rx="2"/></svg></button>
    </div>
  </div>

  <div id="sheet-backdrop"></div>
  <div id="sheet">
    <div class="sheet-head">
      <span class="sh-title" id="sheet-title"></span>
      <button class="sh-close" id="sheet-close"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
    </div>
    <div class="sheet-body" id="sheet-body"></div>
  </div>

  <div id="win-layer"></div>
  <div id="toast"></div>

  <div id="auth-overlay">
    <div class="auth-card">
      <h2>Sky 需要认证</h2>
      <p>此服务器已开启接口认证. 输入访问 token (sk-...) 继续.</p>
      <input id="auth-token-input" type="password" placeholder="sk-..." autocomplete="off">
      <button class="btn" id="auth-login-btn">验证并进入</button>
      <div class="status" id="auth-status"></div>
    </div>
  </div>
</div>
<script>
// ================================================================================
// 基础助手
// ================================================================================
function $(id) { return document.getElementById(id); }
function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
let toastTimer = null;
function toast(text) {
  const t = $('toast'); t.textContent = text; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
}

// ================================================================================
// 认证 — token 存 localStorage, 请求附带 Bearer; 401 → 登录层
// ================================================================================
const AUTH_KEY = 'sky_token';
function storedToken() { try { return localStorage.getItem(AUTH_KEY) || ''; } catch (e) { return ''; } }
function saveToken(t) { try { if (t) localStorage.setItem(AUTH_KEY, t); else localStorage.removeItem(AUTH_KEY); } catch (e) {} }
function authHeaders() {
  const t = storedToken();
  return t ? { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t } : { 'Content-Type': 'application/json' };
}
let authInfo = null;
async function verifyAuthToken() {
  try { const r = await fetch('/api/auth/verify', { headers: authHeaders() }); authInfo = await r.json(); } catch (e) { authInfo = null; }
  return authInfo;
}
function showLogin() { $('auth-overlay').classList.add('show'); const i = $('auth-token-input'); setTimeout(function () { i.focus(); }, 60); }
function hideLogin() { $('auth-overlay').classList.remove('show'); }
function setupLogin() {
  const tryLogin = async function () {
    const t = $('auth-token-input').value.trim(); if (!t) return;
    saveToken(t);
    const info = await verifyAuthToken();
    if (info && info.authed) { hideLogin(); location.reload(); }
    else { saveToken(''); const s = $('auth-status'); s.textContent = 'token 无效或已吊销'; s.className = 'status err'; }
  };
  $('auth-login-btn').onclick = tryLogin;
  $('auth-token-input').onkeydown = function (e) { if (e.key === 'Enter') tryLogin(); };
}

// ================================================================================
// dispatch 助手 (401 → 登录层)
// ================================================================================
let dispatchSeq = 0;
function dispatch(cap, params) {
  return fetch('/api/dispatch', {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ cap: cap, params: params, reqId: 'h-' + (++dispatchSeq) }),
  }).then(function (r) {
    if (r.status === 401) { showLogin(); return { result: { data: null } }; }
    return r.json();
  }).then(function (r) { return r.result && r.result.data !== undefined ? r.result.data : null; })
    .catch(function (e) { console.warn('[dispatch] ' + cap, e); return null; });
}

// ================================================================================
// Markdown 渲染 + 轻量代码高亮
// ================================================================================
function renderMarkdown(text) {
  const BT = String.fromCharCode(96); const fence = BT + BT + BT;
  let html = esc(text);
  const reFence = new RegExp(fence + '(\\\\w*)\\\\n([\\\\s\\\\S]*?)' + fence, 'g');
  html = html.replace(reFence, function (_, lang, code) {
    return '<div class="codeblock">' +
      '<div class="code-lang"><span>' + esc(lang || 'code') + '</span></div>' +
      '<pre><code>' + highlight(code.replace(/&quot;/g, '"')) + '</code></pre></div>';
  });
  const reInline = new RegExp(BT + '([^' + BT + '\\\\n]+)' + BT, 'g');
  html = html.replace(reInline, '<code>$1</code>');
  html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  html = html.split(/\\n{2,}/).map(function (p) { return '<p>' + p.replace(/\\n/g, '<br>') + '</p>'; }).join('');
  return html;
}
function highlight(code) {
  const kw = 'const|let|var|function|return|if|else|for|while|import|from|export|class|new|await|async|try|catch|finally|throw|typeof|of|in|switch|case|break|continue|default|true|false|null|undefined|this|interface|type|enum|public|private|extends|implements';
  const re = new RegExp('(\\\\/\\\\/[^\\\\n]*|\\\\/\\\\*[\\\\s\\\\S]*?\\\\*\\\\/)|\\\\b(' + kw + ')\\\\b|\\\\b(\\\\d+(?:\\\\.\\\\d+)?)\\\\b', 'g');
  return code.replace(re, function (m, c, k, n) {
    if (c) return '<span class="hl-c">' + c + '</span>';
    if (k) return '<span class="hl-k">' + k + '</span>';
    return '<span class="hl-n">' + n + '</span>';
  });
}
function wireCopyButtons(rootEl) {
  rootEl.querySelectorAll('.codeblock').forEach(function (blk) {
    if (blk.querySelector('.copy-btn')) return;
    const langEl = blk.querySelector('.code-lang');
    if (!langEl) return;
    const btn = document.createElement('button');
    btn.className = 'copy-btn'; btn.textContent = '复制';
    btn.onclick = function () {
      const code = blk.querySelector('code');
      navigator.clipboard.writeText(code ? code.textContent : '').then(function () {
        btn.textContent = '已复制'; setTimeout(function () { btn.textContent = '复制'; }, 1400);
      });
    };
    langEl.appendChild(btn);
  });
}

// ================================================================================
// WebSocket — 重连退避 + 心跳 + 重连后状态恢复
// ================================================================================
let ws = null;
let wsBackoff = 1000;
let wsHbTimer = null;
let lastPong = Date.now();
let streamOrphaned = false;   // 断线时是否遗留了未完成的流
const pendingStreamReplies = {};   // reqId → callback(streamId)
const pendingDispatch = [];

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = storedToken();
  const url = proto + '://' + location.host + '/ws' + (token ? '?token=' + encodeURIComponent(token) : '');
  ws = new WebSocket(url);
  ws.onopen = function () {
    wsBackoff = 1000; lastPong = Date.now();
    ws.send(JSON.stringify({ type: 'shell-register', caps: [] }));
    // 断线遗留的流强制作废; 但排队中的 dispatch (还没发出去) 不算遗留 — 不能误杀
    if (streaming && streamOrphaned && !pendingDispatch.length) {
      forceEndStream('连接中断, 生成已停止');
    }
    streamOrphaned = false;
    while (pendingDispatch.length) ws.send(JSON.stringify(pendingDispatch.shift()));
    startHeartbeat();
    // 重连后状态恢复: 重拉当前会话消息
    const sid = currentSessionId();
    if (sid && !streaming) loadSessionIntoChat(sid);
  };
  ws.onmessage = function (e) {
    const msg = JSON.parse(e.data);
    if (msg.type === 'reply') {
      const cb = pendingStreamReplies[msg.reqId];
      if (cb) { delete pendingStreamReplies[msg.reqId]; cb(msg.reply); }
    } else if (msg.type === 'event') {
      handleEvent(msg.event);
    } else if (msg.type === 'pong') {
      lastPong = Date.now();
    }
  };
  ws.onclose = function () {
    stopHeartbeat();
    if (streaming) streamOrphaned = true;
    setTimeout(connectWs, wsBackoff);
    wsBackoff = Math.min(wsBackoff * 2, 15000);
  };
  ws.onerror = function () {};
}
function startHeartbeat() {
  stopHeartbeat();
  wsHbTimer = setInterval(function () {
    if (!ws || ws.readyState !== 1) return;
    if (Date.now() - lastPong > 60000) { ws.close(); return; }
    ws.send(JSON.stringify({ type: 'ping' }));
  }, 25000);
}
function stopHeartbeat() { if (wsHbTimer) { clearInterval(wsHbTimer); wsHbTimer = null; } }
function wsSend(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  else pendingDispatch.push(obj);
}
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && (!ws || ws.readyState > 1)) connectWs();
});

// ================================================================================
// 事件路由 (流式 / AI 窗口 / UI State)
// ================================================================================
function handleEvent(ev) {
  // 事件归属: 匹配当前流, 或 reply 未回但流已启动 (竞态: end/error 先于 reply 到达)
  const mine = ev.stream_id === currentStreamId || (streaming && !currentStreamId);
  if (ev.type === 'stream.chunk') {
    if (!mine || !currentMsgEl) return;
    streamRaw += String(ev.data || '');
    currentMsgEl.innerHTML = renderMarkdown(streamRaw);
    scrollMessages();
  } else if (ev.type === 'stream.tool') {
    if (!mine) return;
    addToolCard(ev.data);
  } else if (ev.type === 'stream.toolResult') {
    if (!mine) return;
    finishToolCard(ev.data);
  } else if (ev.type === 'stream.end') {
    if (!mine) return;
    onStreamEnd(ev.data || {}, ev.stream_id);
  } else if (ev.type === 'stream.reasoning') {
    if (!mine) return;
    addThinkingChunk(ev.data);
  } else if (ev.type === 'ui.window') {
    if (ev.data && ev.data.action === 'open') openWindow(ev.data);
    else if (ev.data && ev.data.action === 'close') closeWindow(ev.data.id);
  } else if (ev.type === 'ui.update') {
    if (ev.data) { uiState = ev.data; applyUiState(); }
  }
}

// ================================================================================
// 会话管理 (内置极简抽屉)
// ================================================================================
let sessions = [];
let currentSession = '';
let streaming = false;

function currentSessionId() { return currentSession; }
function setSessionId(id) { currentSession = id || ''; }
// 用户显式的新建/切换会话后, 启动期的 getCurrent 迟到响应不得覆盖 (实测竞态:
// 晚到的旧会话 id 会让后续消息发进错误会话, 表现为"新增会话无效/串话")
let sessionExplicit = false;
function setSessionExplicit() { sessionExplicit = true; }

async function renderSessionList() {
  const data = await dispatch('cap.session', { action: 'list' });
  sessions = (data && data.sessions) || [];
  const cur = (data && data.currentId) || currentSession;
  const host = $('sess-list');
  if (!sessions.length) {
    host.innerHTML = '<div style="padding:16px 8px;color:var(--sky-text-muted,#8b949e);font-size:12.5px;text-align:center;line-height:1.7">暂无会话<br>点上方「新会话」或直接发消息</div>';
    return;
  }
  host.innerHTML = sessions.map(function (s) {
    const active = s.id === cur;
    return '<div class="sess-item' + (active ? ' active' : '') + '" data-sid="' + esc(s.id) + '">' +
      '<div class="s-info"><div class="s-title">' + esc(s.title || '未命名') + '</div>' +
      '<div class="s-meta">' + (s.messages || 0) + ' 条 · ' + fmtTime(s.lastActive) + '</div></div>' +
      '<div class="s-act">' +
      '<button data-ren="' + esc(s.id) + '" title="重命名"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg></button>' +
      '<button class="del" data-del="' + esc(s.id) + '" title="删除"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></button>' +
      '</div></div>';
  }).join('');
  host.querySelectorAll('.sess-item').forEach(function (item) {
    item.onclick = function (e) {
      const ren = e.target.closest('[data-ren]');
      const del = e.target.closest('[data-del]');
      if (ren) { e.stopPropagation(); renameSession(ren.dataset.ren); return; }
      if (del) { e.stopPropagation(); deleteSession(del.dataset.del); return; }
      switchSession(item.dataset.sid);
    };
  });
}
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts); const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toTimeString().slice(0, 5)
    : (d.getMonth() + 1) + '/' + d.getDate();
}

async function newSession() {
  if (streaming) { toast('正在生成中, 请先停止'); return; }
  closeDrawer();
  // 新会话设置: 工作区选择 (可不选) + 可选标题
  const wsData = await dispatch('cap.workspace', { action: 'list' });
  if (!wsData) { toast('无法连接 (可能需要登录)'); return; }  // 401 已弹登录层
  const workspaces = (wsData && wsData.workspaces) || [];
  const wsCur = (wsData && wsData.currentId) || null;
  openSheet('新会话', function (body) {
    body.innerHTML =
      '<div class="field"><label>会话标题 (可选)</label><input id="ns-title" type="text" placeholder="留空则用首条消息"></div>' +
      '<div class="field"><label>工作区 (决定 AI 编辑/读取文件的范围)</label><div id="ns-ws-list"></div></div>' +
      '<button class="btn" id="ns-create" style="width:100%">创建会话</button>' +
      '<div class="status" id="ns-status"></div>';
    const list = body.querySelector('#ns-ws-list');
    let chosen = wsCur;
    const renderWs = function () {
      let html = '<label class="ws-opt' + (chosen === null ? ' active' : '') + '"><input type="radio" name="ns-ws" value=""' + (chosen === null ? ' checked' : '') + '><span>不使用工作区</span></label>';
      html += workspaces.map(function (w) {
        return '<label class="ws-opt' + (chosen === w.id ? ' active' : '') + '"><input type="radio" name="ns-ws" value="' + esc(w.id) + '"' + (chosen === w.id ? ' checked' : '') + '><span>' + esc(w.name) + '<span class="ws-opt-root">' + esc(w.root) + '</span></span></label>';
      }).join('');
      list.innerHTML = html;
      list.querySelectorAll('input[name="ns-ws"]').forEach(function (r) {
        r.onchange = function () { chosen = r.value || null; renderWs(); };
      });
    };
    renderWs();
    body.querySelector('#ns-create').onclick = async function () {
      const s = body.querySelector('#ns-status'); s.textContent = '创建中...'; s.className = 'status';
      // 工作区是全局态: 显式选择 → 切换; 选"不使用" → 清空当前选择
      if (chosen !== wsCur) {
        const sw = await dispatch('cap.workspace', chosen ? { action: 'switch', id: chosen } : { action: 'unset' });
        if (!sw) { s.textContent = '保存失败 (可能需要登录)'; s.className = 'status err'; return; }
      }
      const title = body.querySelector('#ns-title').value.trim();
      const data = await dispatch('cap.session', { action: 'create' });
      if (data && data.id) {
        if (title) await dispatch('cap.session', { action: 'rename', sessionId: data.id, title: title });
        setSessionId(data.id); setSessionExplicit(); clearChat(); showWelcome(); renderSessionList();
        while (sheetStack.length) closeSheet();
        $('input').focus();
        toast('新会话已创建');
      } else {
        s.textContent = '创建失败 (可能需要登录, 或稍后重试)'; s.className = 'status err';
        toast('会话创建失败');
      }
    };
  });
}
async function switchSession(id) {
  if (streaming) { toast('正在生成中, 请先停止'); return; }
  // 乐观 UI: 立即关抽屉切状态, 网络慢也不卡手感
  closeDrawer(); hideWelcome(); setSessionId(id); setSessionExplicit(); clearChat();
  const okSw = await dispatch('cap.session', { action: 'switch', sessionId: id });
  if (!okSw) { toast('切换失败 (可能需要登录)'); }
  await loadSessionIntoChat(id);
  renderSessionList();
}
async function deleteSession(id) {
  if (!window.confirm('删除该会话? 聊天记录将一并删除')) return;
  const data = await dispatch('cap.session', { action: 'delete', sessionId: id });
  if (data && data.wasCurrent) { setSessionId(''); clearChat(); showWelcome(); }
  renderSessionList();
}
async function renameSession(id) {
  const s = sessions.find(function (x) { return x.id === id; });
  const name = window.prompt('重命名会话', (s && s.title) || '');
  if (!name || !name.trim()) return;
  await dispatch('cap.session', { action: 'rename', sessionId: id, title: name.trim() });
  renderSessionList();
}
async function ensureSession(title) {
  let sid = currentSessionId();
  if (sid) return sid;
  const data = await dispatch('cap.session', { action: 'create' });
  if (data && data.id) { setSessionId(data.id); setSessionExplicit(); renderSessionList(); return data.id; }
  toast('会话创建失败 (可能需要登录)');
  return '';
}
async function loadSessionIntoChat(id) {
  const msgs = $('messages'); if (!msgs) return;
  const data = await dispatch('cap.history', { action: 'list', sessionId: id });
  const hist = (data && data.messages) || [];
  clearChat();
  if (!hist.length) { showWelcome(); return; }
  hideWelcome();
  for (const m of hist) {
    // user 走 textContent (无需 esc, 双重转义会让 &quot; 字面显示); assistant 走 markdown html
    if (m.role === 'user') addMsgEl('user', String(m.content || ''));
    else addMsgEl('assistant', renderMarkdown(String(m.content || '')), true);
  }
  wireCopyButtons($('messages'));
  scrollMessages();
}
function clearChat() { $('messages').innerHTML = ''; }
function showWelcome() { $('welcome').style.display = ''; }
function hideWelcome() { $('welcome').style.display = 'none'; }

function openDrawer() { $('drawer').classList.add('open'); $('drawer-backdrop').classList.add('show'); renderSessionList(); }
function closeDrawer() { $('drawer').classList.remove('open'); $('drawer-backdrop').classList.remove('show'); }

// ================================================================================
// 对话 — 发送 / 停止 / 工具活动卡
// ================================================================================
let currentStreamId = null;
let currentMsgEl = null;
let streamRaw = '';
let toolSeq = 0;
const toolCards = {};
const streamEls = new Map();   // streamId → assistant 元素 (旧流收尾不误伤新流)

function scrollMessages() {
  const sc = $('scroll'); sc.scrollTop = sc.scrollHeight + 9999;
}
function addMsgEl(cls, htmlOrText, isHtml) {
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  if (isHtml) el.innerHTML = htmlOrText; else el.textContent = htmlOrText;
  $('messages').appendChild(el);
  return el;
}
function addMsg(cls, text) {
  const el = addMsgEl(cls, text);
  if (cls === 'assistant') { el.innerHTML = renderMarkdown(text); wireCopyButtons(el); }
  scrollMessages(); return el;
}

function setStreaming(on) {
  streaming = on;
  const btn = $('send-btn');
  btn.classList.toggle('stop', on);
  $('ic-send').style.display = on ? 'none' : '';
  $('ic-stop').style.display = on ? '' : 'none';
  btn.title = on ? '停止' : '发送';
}
// 思考链卡片 (推理模型 reasoning_content) — 折叠可展开, 结束后自动收起
let thinkingEl = null;
function addThinkingChunk(text) {
  if (!thinkingEl) {
    thinkingEl = document.createElement('div');
    thinkingEl.className = 'think-card';
    thinkingEl.innerHTML = '<div class="think-head"><span class="t-dot" style="background:var(--sky-text-muted,#8b949e)"></span><span class="think-label">思考中…</span><span class="think-chev"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></span></div><div class="think-body"></div>';
    thinkingEl.querySelector('.think-head').onclick = function () { thinkingEl.classList.toggle('open'); };
    if (currentMsgEl) $('messages').insertBefore(thinkingEl, currentMsgEl);
    else $('messages').appendChild(thinkingEl);
  }
  const body = thinkingEl.querySelector('.think-body');
  body.appendChild(document.createTextNode(text));
  body.scrollTop = body.scrollHeight;
  scrollMessages();
}
function finishThinking() {
  if (!thinkingEl) return;
  const label = thinkingEl.querySelector('.think-label');
  if (label) label.textContent = '思考过程';
  thinkingEl.classList.remove('open'); // 结束后收起 (点头部可展开)
  thinkingEl = null;
}
function addToolCard(data) {
  const seq = ++toolSeq;
  const el = document.createElement('div');
  el.className = 'tool-card run';
  const argsJson = JSON.stringify(data.args || {}, null, 2);
  el.innerHTML = '<div class="t-head"><span class="t-dot"></span><span class="t-name">' + esc(data.name || '') + '</span>' +
    '<span class="t-args">' + esc(JSON.stringify(data.args || {}).slice(0, 110)) + '</span>' +
    '<span class="t-ms"></span>' +
    '<span class="t-chev"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></span></div>' +
    '<div class="t-detail"><div class="td-label">请求参数</div><pre>' + esc(argsJson) + '</pre></div>';
  el._start = Date.now();
  el.querySelector('.t-head').onclick = function () { if (!el.classList.contains('run')) el.classList.toggle('open'); };
  $('messages').insertBefore(el, currentMsgEl);
  toolCards[seq] = el;
  // 挂到当前流的最新序号, toolResult 事件不带序号 → 用最后一个 run 态同名卡
  toolCards['last_' + data.name] = el;
  scrollMessages();
}
function finishToolCard(data) {
  const el = toolCards['last_' + data.name];
  if (!el) return;
  const ok = data.result && data.result.ok !== false;
  el.classList.remove('run'); el.classList.add(ok ? 'ok' : 'err');
  el.querySelector('.t-ms').textContent = ((Date.now() - el._start) / 1000).toFixed(1) + 's';
  const detail = el.querySelector('.t-detail');
  const resultText = JSON.stringify(data.result, null, 2);
  detail.innerHTML += '<div class="td-label">响应' + (ok ? '' : ' (错误)') + '</div><pre>' +
    esc(resultText.slice(0, 4000)) + (resultText.length > 4000 ? '\\n…' : '') + '</pre>';
  el.querySelector('.t-args').textContent = ok ? '完成' : '失败: ' + ((data.result && data.result.error) || '').slice(0, 80);
}
function onStreamEnd(data, sid) {
  finishThinking();
  const el = (sid && streamEls.get(sid)) || currentMsgEl;
  setStreaming(false);
  if (data.aborted && el && el !== currentMsgEl) {
    // 旧流收尾: 只清它自己的元素, 不碰当前流
    el.classList.remove('typing');
    if (!el.textContent.trim()) el.innerHTML = '<span style="color:var(--sky-text-muted,#8b949e)">(已停止)</span>';
    if (sid) streamEls.delete(sid);
    return;
  }
  if (data.aborted) {
    const note = document.createElement('div');
    note.className = 'msg-note'; note.textContent = '已停止生成';
    $('messages').appendChild(note);
  }
  if (el) {
    el.classList.remove('typing');
    if (!streamRaw.trim() && data.ok === false && data.error) {
      el.innerHTML = '<span style="color:var(--sky-danger,#f85149)">出错了: ' + esc(data.error) + '</span>';
    } else if (!streamRaw.trim()) {
      el.innerHTML = '<span style="color:var(--sky-text-muted,#8b949e)">(空回复 — 模型可能只输出了思考链, 可在设置调大 max_tokens)</span>';
    }
    wireCopyButtons(el);
  }
  if (sid) streamEls.delete(sid);
  currentMsgEl = null; currentStreamId = null; streamRaw = '';
  // 重新生成入口 (非错误/中断也提供)
  $('messages').querySelectorAll('.msg-actions').forEach(function (n) { n.remove(); });
  if (data.ok !== false) {
    const act = document.createElement('div');
    act.className = 'msg-actions';
    act.innerHTML = '<button class="regen-btn"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>重新生成</button>';
    act.querySelector('.regen-btn').onclick = regenerate;
    $('messages').appendChild(act);
  }
  scrollMessages();
  renderSessionList();
}
async function regenerate() {
  if (streaming) return;
  const sid = currentSessionId(); if (!sid) return;
  const rm = await dispatch('cap.history', { action: 'deleteLast', sessionId: sid });
  if (!rm || rm.ok === false) { toast('没有可重新生成的内容'); return; }
  const hist = await dispatch('cap.history', { action: 'list', sessionId: sid });
  const msgs = (hist && hist.messages) || [];
  const lastUser = [...msgs].reverse().find(function (m) { return m.role === 'user'; });
  if (!lastUser) { toast('没有可重新生成的用户消息'); return; }
  // 视图: 移除末尾 assistant 元素与旧 action 行, 重新流式
  const els = [...$('messages').children].filter(function (e) { return e.className.indexOf('assistant') !== -1; });
  if (els.length) els[els.length - 1].remove();
  const acts = $('messages').querySelectorAll('.msg-actions'); acts.forEach(function (n) { n.remove(); });
  setStreaming(true); streamRaw = '';
  currentMsgEl = addMsgEl('assistant', ''); currentMsgEl.classList.add('typing');
  thinkingEl = null;
  scrollMessages();
  const reqId = 'regen-' + Date.now().toString(36);
  pendingStreamReplies[reqId] = function (reply) {
    if (!streaming) return;
    if (reply && reply.result && reply.result.ok) {
      currentStreamId = reply.result.data.streamId;
      if (currentMsgEl) streamEls.set(currentStreamId, currentMsgEl);
    } else {
      setStreaming(false);
      if (currentMsgEl) currentMsgEl.classList.remove('typing');
      const err = (reply && reply.result && reply.result.error) || '启动失败';
      addMsgEl('assistant', renderMarkdown('**出错了:** ' + err), true);
    }
  };
  wsSend({ type: 'dispatch', reqId: reqId, cap: 'cap.ai.chat', stream: true, params: { messages: [{ role: 'user', content: String(lastUser.content || '') }], sessionId: sid, regenerate: true } });
}
function forceEndStream(reason) {
  finishThinking();
  setStreaming(false);
  if (currentMsgEl) {
    currentMsgEl.classList.remove('typing');
    if (!streamRaw.trim()) currentMsgEl.innerHTML = '<span style="color:var(--sky-text-muted,#8b949e)">(' + esc(reason) + ')</span>';
  }
  const note = document.createElement('div');
  note.className = 'msg-note'; note.textContent = reason;
  $('messages').appendChild(note);
  currentMsgEl = null; currentStreamId = null; streamRaw = '';
  renderSessionList();
}

async function send() {
  const input = $('input');
  if (streaming) { stopStreaming(); return; }
  const text = input.value.trim(); if (!text) return;
  const sid = await ensureSession(text);
  if (!sid) { toast('会话创建失败'); return; }
  input.value = ''; autoGrow();
  hideWelcome();
  addMsg('user', text);
  setStreaming(true);
  streamRaw = '';
  currentMsgEl = addMsgEl('assistant', ''); currentMsgEl.classList.add('typing');
  thinkingEl = null;
  scrollMessages();
  const reqId = 'req-' + Date.now().toString(36);
  pendingStreamReplies[reqId] = function (reply) {
    if (!streaming) return; // end/error 事件先于 reply 到达, 已恢复, 忽略
    if (reply && reply.result && reply.result.ok) {
      currentStreamId = reply.result.data.streamId;
      if (currentMsgEl) streamEls.set(currentStreamId, currentMsgEl);
    } else {
      setStreaming(false);
      if (currentMsgEl) currentMsgEl.classList.remove('typing');
      const err = (reply && reply.result && reply.result.error) || '启动失败';
      addMsgEl('assistant', renderMarkdown('**出错了:** ' + err), true);
    }
  };
  wsSend({ type: 'dispatch', reqId: reqId, cap: 'cap.ai.chat', stream: true, params: { messages: [{ role: 'user', content: text }], sessionId: sid } });
}
function stopStreaming() {
  if (currentStreamId) wsSend({ type: 'stream.abort', streamId: currentStreamId });
}

// ================================================================================
// 底部抽屉 (sheet) — 通用容器
// ================================================================================
const sheetStack = [];
function openSheet(title, buildBody) {
  const entry = { title: title };
  // 清理上一个窗口 sheet 留下的最小化按钮
  const stale = document.querySelector('#sheet .sh-min');
  if (stale) stale.remove();
  $('sheet-title').textContent = title;
  const body = $('sheet-body');
  body.innerHTML = '';
  try { buildBody(body, entry); }
  catch (e) {
    console.error('[sheet build]', e);
    body.innerHTML = '<div style="padding:24px;text-align:center;color:var(--sky-danger,#f85149);font-size:12.5px;line-height:1.7">面板加载失败<br><code>' + esc(String(e && e.message || e)) + '</code></div>';
    toast('面板加载失败: ' + (e && e.message || e));
  }
  // buildBody 失败已在 body 里展示错误信息, 仍然入栈让用户能看到错误并关闭
  sheetStack.push(entry);
  $('sheet').classList.add('show');
  $('sheet-backdrop').classList.add('show');
  return entry;
}
function closeSheet() {
  const entry = sheetStack.pop();
  if (entry && entry.onClose) { try { entry.onClose(); } catch (e) {} }
  if (!sheetStack.length) {
    $('sheet').classList.remove('show');
    $('sheet-backdrop').classList.remove('show');
  } else {
    const top = sheetStack[sheetStack.length - 1];
    $('sheet-title').textContent = top.title;
  }
}
function setupSheet() {
  $('sheet-close').onclick = closeSheet;
  $('sheet-backdrop').onclick = closeSheet;
}

// ================================================================================
// 窗口管理 — cap.ui.window 双形态 (≤640px 底部抽屉 / 桌面悬浮窗)
// 支持最小化 + 窗口托盘 (顶栏 ▣ 恢复/关闭)
// ================================================================================
const openWindows = new Map();
let winZ = 100;
function renderWinBadge() {
  const btn = $('tb-wins');
  const n = openWindows.size;
  btn.style.display = n ? '' : 'none';
  $('win-count').textContent = String(n);
}
function openWindow(w) {
  const prev = openWindows.get(w.id);
  if (prev && prev._min) { restoreWindow(prev); return; }
  if (prev) closeWindow(w.id);
  openWindows.set(w.id, w);
  renderWinBadge();
  if (window.matchMedia('(max-width: 640px)').matches) {
    const entry = openSheet(w.title, function (body) { buildWindowBody(body, w); });
    entry.winId = w.id;
    entry.onClose = function () { if (!w._min) { openWindows.delete(w.id); renderWinBadge(); } };
    entry._minBtn = true;
    addSheetMinimize(w);
  } else {
    const el = document.createElement('div');
    el.className = 'win'; el.dataset.wid = w.id;
    const width = Math.min(w.width || 420, window.innerWidth - 40);
    const height = Math.min(w.height || 480, window.innerHeight - 100);
    const n = document.querySelectorAll('.win').length;
    el.style.width = width + 'px'; el.style.height = height + 'px';
    el.style.left = Math.max(12, Math.min(80 + n * 28, window.innerWidth - width - 12)) + 'px';
    el.style.top = Math.max(12, 70 + n * 24) + 'px';
    el.style.zIndex = ++winZ;
    el.innerHTML = '<div class="win-head"><span class="w-title">' + esc(w.title) + '</span>' +
      '<button class="w-min" title="最小化"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/></svg></button>' +
      '<button class="w-close" title="关闭"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div>' +
      '<div class="win-body"></div>';
    $('win-layer').appendChild(el);
    w._el = el;
    el.querySelector('.w-close').onclick = function () { closeWindow(w.id); };
    el.querySelector('.w-min').onclick = function () { minimizeWindow(w); };
    el.addEventListener('pointerdown', function () { el.style.zIndex = ++winZ; });
    makeDraggable(el.querySelector('.win-head'), el);
    buildWindowBody(el.querySelector('.win-body'), w);
  }
  toast('AI 已打开: ' + w.title);
}
function minimizeWindow(w) {
  w._min = true;
  renderWinBadge();
  if (w._el) { w._el.style.display = 'none'; toast('已最小化, 点顶栏 ▣ 恢复'); }
  else if (sheetStack.length && sheetStack[sheetStack.length - 1].winId === w.id) {
    closeSheet();
    toast('已最小化, 点顶栏 ▣ 恢复');
  }
}
function restoreWindow(w) {
  w._min = false;
  renderWinBadge();
  if (w._el) { w._el.style.display = 'flex'; w._el.style.zIndex = ++winZ; return; }
  if (window.matchMedia('(max-width: 640px)').matches) {
    if (sheetStack.length) { toast('请先关闭当前面板'); w._min = true; return; }
    const entry = openSheet(w.title, function (body) { buildWindowBody(body, w); });
    entry.winId = w.id;
    entry.onClose = function () { if (!w._min) { openWindows.delete(w.id); renderWinBadge(); } };
    addSheetMinimize(w);
  }
}
function addSheetMinimize(w) {
  // sheet 标题栏加最小化按钮 (手机形态)
  const head = document.querySelector('#sheet .sheet-head');
  if (!head || head.querySelector('.sh-min')) return;
  const btn = document.createElement('button');
  btn.className = 'sh-close sh-min'; btn.title = '最小化';
  btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/></svg>';
  btn.onclick = function (e) { e.stopPropagation(); minimizeWindow(w); };
  head.insertBefore(btn, head.querySelector('.sh-close'));
}
function openWindowTray() {
  openSheet('窗口', function (body) {
    const wins = Array.from(openWindows.values());
    if (!wins.length) {
      body.innerHTML = '<div style="padding:24px;text-align:center;color:var(--sky-text-muted,#8b949e);font-size:13px;line-height:1.8">没有打开的窗口<br>对 AI 说「开一个窗口展示…」即可</div>';
      return;
    }
    body.innerHTML = wins.map(function (w) {
      return '<div class="tray-item"><div class="tray-info"><div class="tray-title">' + esc(w.title) +
        (w._min ? ' <span style="color:var(--sky-text-muted,#8b949e);font-size:10px">(最小化)</span>' : '') + '</div></div>' +
        '<button class="btn secondary" data-focus="' + esc(w.id) + '">打开</button>' +
        '<button class="btn secondary" data-wclose="' + esc(w.id) + '">关闭</button></div>';
    }).join('');
    body.querySelectorAll('[data-focus]').forEach(function (b) {
      b.onclick = function () {
        const w = openWindows.get(b.dataset.focus);
        while (sheetStack.length) closeSheet();
        if (w) restoreWindow(w);
      };
    });
    body.querySelectorAll('[data-wclose]').forEach(function (b) {
      b.onclick = function () { closeWindow(b.dataset.wclose); openWindowTray(); };
    });
  });
}
function closeWindow(id) {
  const w = openWindows.get(id);
  if (w && w._styleEl) w._styleEl.remove();
  openWindows.delete(id);
  const el = document.querySelector('.win[data-wid="' + id + '"]');
  if (el) el.remove();
  renderWinBadge();
}
function buildWindowBody(rootEl, w) {
  rootEl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'sky-win-content';
  rootEl.appendChild(wrap);
  if (w.css) {
    const styleEl = document.createElement('style');
    styleEl.textContent = scopeCss(w.css, wrap);
    document.head.appendChild(styleEl);
    w._styleEl = styleEl;
  }
  wrap.innerHTML = w.html || '';
  if (w.js) execCustomJs(w.js, wrap, { dispatch: dispatch, close: function () { closeWindow(w.id); }, toast: toast });
}
function makeDraggable(handle, el) {
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  handle.addEventListener('pointerdown', function (e) {
    if (e.target.closest('.w-close')) return;
    dragging = true; sx = e.clientX; sy = e.clientY;
    ox = el.offsetLeft; oy = el.offsetTop;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    el.style.left = Math.max(-el.offsetWidth + 80, ox + e.clientX - sx) + 'px';
    el.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
  });
  handle.addEventListener('pointerup', function () { dragging = false; });
}

// ================================================================================
// AI 内联组件 (cap.ui.component mountPoint=inline) + 作用域 CSS + 沙箱 JS
// ================================================================================
let uiState = null;
let dynamicStyle = null;
const inlineLive = new Map();
function kebab(s) { return s.replace(/([A-Z])/g, '-$1').toLowerCase(); }

function applyUiState() {
  if (!uiState) return;
  const t = uiState.theme || {};
  let css = ':root{';
  for (const k in (t.colors || {})) css += '--sky-' + kebab(k) + ':' + t.colors[k] + ';';
  for (const k in (t.spacing || {})) css += '--sky-' + kebab(k) + ':' + t.spacing[k] + ';';
  for (const k in (t.typography || {})) css += '--sky-' + kebab(k) + ':' + t.typography[k] + ';';
  for (const k in (t.radii || {})) css += '--sky-' + kebab(k) + ':' + t.radii[k] + ';';
  css += '}';
  for (const rule of (uiState.styles || [])) {
    css += rule.selector + '{' + Object.keys(rule.properties || {}).map(function (k) { return kebab(k) + ':' + rule.properties[k]; }).join(';') + '}';
  }
  if (!dynamicStyle) { dynamicStyle = document.createElement('style'); document.head.appendChild(dynamicStyle); }
  dynamicStyle.textContent = css;
  renderInlineComponents();
}
function renderInlineComponents() {
  if (!uiState || !uiState.components) return;
  const host = $('inline-host'); if (!host) return;
  const inline = (uiState.components || []).filter(function (c) {
    return c.type === 'custom' && ['inline', 'chat', 'card'].indexOf(c.mountPoint) !== -1;
  });
  // 清理已移除的
  for (const id of Array.from(inlineLive.keys())) {
    if (!inline.find(function (c) { return c.id === id; })) {
      const rec = inlineLive.get(id);
      if (rec.el) rec.el.remove();
      if (rec.styleEl) rec.styleEl.remove();
      inlineLive.delete(id);
    }
  }
  for (const comp of inline) {
    const sig = JSON.stringify(comp.props || {});
    const rec = inlineLive.get(comp.id);
    if (rec && rec.sig === sig) continue;
    if (rec) { rec.el.remove(); if (rec.styleEl) rec.styleEl.remove(); inlineLive.delete(comp.id); }
    const el = document.createElement('div');
    el.className = 'inline-card';
    const props = comp.props || {};
    if (props.css) {
      const styleEl = document.createElement('style');
      styleEl.textContent = scopeCss(props.css, el);
      document.head.appendChild(styleEl);
      var styleElRef = styleEl;
    }
    el.innerHTML = props.html || '';
    $('inline-host').appendChild(el);
    if (props.js) execCustomJs(props.js, el, { dispatch: dispatch, toast: toast, close: function () {} });
    inlineLive.set(comp.id, { el: el, styleEl: styleElRef || null, sig: sig });
  }
}
function scopeCss(css, wrapper) {
  if (!css) return '';
  const id = 'sky-c-' + Math.random().toString(36).slice(2, 9);
  wrapper.id = wrapper.id ? wrapper.id + ' ' + id : id;
  const PREFIX = '#' + id + ' '; let depth = 0; let kfDepth = -1;
  return css.replace(/\\s*([^{}]*)\\{|\\}/g, function (m) {
    if (m === '}') { if (depth === kfDepth) kfDepth = -1; depth--; return '}'; }
    const sel = m.replace(/\\{$/, '').trim();
    if (/^@/.test(sel)) { if (/^@keyframes/i.test(sel)) kfDepth = depth + 1; depth++; return m; }
    const inKeyframes = depth === kfDepth; depth++;
    if (inKeyframes) return m;
    const parts = sel.split(',').map(function (s) { return PREFIX + s.trim(); }).join(', ');
    return parts + ' {';
  });
}
function execCustomJs(code, root, api) {
  try { const factory = new Function('root', '__sky', code); factory(root, api); return null; }
  catch (e) { console.warn('[inline js]', e); return e; }
}

// ================================================================================
// 设置 sheet (极简兜底: AI 配置 / 主题 / 认证 / 存储 / 关于)
// ================================================================================
function openSettings() {
  openSheet('设置', function (body) {
    body.innerHTML =
      '<div class="set-sec"><h3>AI 配置</h3>' +
      '<div class="field"><label>Base URL (OpenAI 兼容)</label><input id="st-base" type="text" placeholder="https://api.openai.com/v1"></div>' +
      '<div class="field"><label>API Key</label><input id="st-key" type="password" placeholder="sk-..."></div>' +
      '<div class="field"><label>模型</label><input id="st-model" type="text" placeholder="gpt-4o-mini"></div>' +
      '<button class="btn" id="st-ai-save">保存</button><div class="status" id="st-ai-status"></div></div>' +
      '<div class="set-sec"><h3>主题</h3><div id="st-themes"><span style="font-size:12px;color:var(--sky-text-muted,#8b949e)">加载中...</span></div></div>' +
      '<div class="set-sec"><h3>认证</h3><div id="st-auth"><span style="font-size:12px;color:var(--sky-text-muted,#8b949e)">加载中...</span></div></div>' +
      '<div class="set-sec"><h3>数据存储</h3><div id="st-storage"><span style="font-size:12px;color:var(--sky-text-muted,#8b949e)">加载中...</span></div></div>' +
      '<div class="set-sec"><h3>关于</h3><div style="font-size:12.5px;line-height:1.8;color:var(--sky-text-muted,#8b949e)">Sky · Capability OS<br>AI 对话即全功能 · <span id="st-caps">...</span></div></div>';

    // AI 配置
    dispatch('cap.config', { action: 'get' }).then(function (cfg) {
      const el = $('st-base');
      if (!el) return; // 面板已关
      const ai = (cfg && cfg.ai) || {};
      el.value = ai.baseUrl || '';
      $('st-key').value = ai.apiKey || '';
      $('st-model').value = ai.model || '';
    }).catch(function (e) { console.warn('[settings] config.get', e); });
    $('st-ai-save').onclick = async function () {
      const s = $('st-ai-status'); s.textContent = '保存中...'; s.className = 'status';
      const data = await dispatch('cap.config', { action: 'patch', value: { ai: { baseUrl: $('st-base').value.trim(), apiKey: $('st-key').value.trim(), model: $('st-model').value.trim() } } });
      if (data && data.ok !== false) { s.textContent = '已保存'; s.className = 'status ok'; }
      else { s.textContent = '失败: ' + ((data && data.error) || '未知'); s.className = 'status err'; }
    };

    // 主题
    dispatch('cap.ui.theme', { action: 'presets' }).then(function (data) {
      const host = $('st-themes');
      if (!host) return; // 面板已关
      const presets = (data && data.presets) || [];
      if (!presets.length) { host.innerHTML = '<span style="font-size:12px;color:var(--sky-text-muted,#8b949e)">无可用主题</span>'; return; }
      host.innerHTML = presets.map(function (p) {
        return '<button class="theme-chip" data-theme="' + esc(p) + '">' + esc(p) + '</button>';
      }).join('');
      host.querySelectorAll('[data-theme]').forEach(function (chip) {
        chip.onclick = async function () {
          await dispatch('cap.ui.theme', { action: 'apply', preset: chip.dataset.theme });
          toast('主题: ' + chip.dataset.theme);
        };
      });
    }).catch(function (e) {
      const host = $('st-themes');
      if (host) host.innerHTML = '<span style="font-size:12px;color:var(--sky-text-muted,#8b949e)">加载失败</span>';
      console.warn('[settings] theme.presets', e);
    });

    // 认证
    dispatch('cap.auth', { action: 'verify' }).then(function (info) {
      const host = $('st-auth');
      if (!host) return; // 面板已关
      const line = function (ok, text) { return '<span style="color:' + (ok ? '#3fb950' : 'var(--sky-danger,#f85149)') + '">' + text + '</span>'; };
      let html = '<div style="font-size:12.5px;line-height:1.8;color:var(--sky-text-muted,#8b949e)">' +
        '强制认证: ' + line(info && info.authRequired, info && info.authRequired ? '开' : '关 (本地开发)') +
        ' · 当前身份: ' + (info && info.authed ? esc(info.authName || '已认证') : '未认证') + '</div>';
      html += '<button class="btn secondary" id="st-logout" style="margin-top:6px">' + (storedToken() ? '清除本机 token' : '本机未存 token') + '</button>';
      host.innerHTML = html;
      $('st-logout').onclick = function () {
        saveToken(''); toast('已清除, 刷新后生效'); setTimeout(function () { location.reload(); }, 800);
      };
    }).catch(function (e) {
      const host = $('st-auth');
      if (host) host.innerHTML = '<span style="font-size:12px;color:var(--sky-text-muted,#8b949e)">读取失败</span>';
      console.warn('[settings] auth.verify', e);
    });

    // 存储
    dispatch('cap.storage', { action: 'info' }).then(function (data) {
      const host = $('st-storage');
      if (!host) return; // 面板已关
      if (!data || data.ok === false) { host.innerHTML = '<span style="font-size:12px;color:var(--sky-text-muted,#8b949e)">读取失败</span>'; return; }
      const fmt = function (n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB'; };
      host.innerHTML = '<div style="font-size:12.5px;line-height:1.8;color:var(--sky-text-muted,#8b949e)">' +
        esc(data.backend || '') + ' · ' + (data.size != null ? fmt(data.size) : '?') + ' · ' +
        Object.keys(data.tables || {}).length + ' 表<br><span style="word-break:break-all">' + esc(data.path || '') + '</span></div>';
    }).catch(function (e) {
      const host = $('st-storage');
      if (host) host.innerHTML = '<span style="font-size:12px;color:var(--sky-text-muted,#8b949e)">读取失败</span>';
      console.warn('[settings] storage.info', e);
    });

    dispatch('cap.shell', { action: 'info' }).then(function (info) {
      const el = $('st-caps');
      if (!el) return; // 面板已关
      if (info && info.caps !== undefined) el.textContent = info.caps + ' caps';
    }).catch(function (e) { console.warn('[settings] shell.info', e); });
  });
}

// ================================================================================
// 欢迎屏建议
// ================================================================================
const SUGGESTIONS = [
  { icon: 'M12 2l2.4 5.8L20 10l-5.6 2.2L12 18l-2.4-5.8L4 10l5.6-2.2z', text: '你现在有哪些能力？' },
  { icon: 'M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36A5.39 5.39 0 0 1 12 3z', text: '把主题换成 midnight' },
  { icon: 'M4 4h16v12H5.2L4 17.2z', text: '开一个悬浮窗展示时钟' },
  { icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', text: '看看当前工作区的文件结构' },
];
function renderWelcome() {
  const host = $('w-chips');
  host.innerHTML = SUGGESTIONS.map(function (s, i) {
    return '<button class="w-chip" data-idx="' + i + '"><span class="chip-ic"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="' + s.icon + '"/></svg></span>' + esc(s.text) + '</button>';
  }).join('');
  host.querySelectorAll('.w-chip').forEach(function (chip) {
    chip.onclick = function () {
      $('input').value = SUGGESTIONS[chip.dataset.idx].text;
      send();
    };
  });
}

// ================================================================================
// 输入区 — 多行自适应 / Enter 发送
// ================================================================================
function autoGrow() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 132) + 'px';
}

// ================================================================================
// 键盘适配 (visualViewport → --kb-offset)
// ================================================================================
function setupKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const onVV = function () {
    const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--kb-offset', offset + 'px');
    scrollMessages();
  };
  vv.addEventListener('resize', onVV);
  vv.addEventListener('scroll', onVV);
}

// ================================================================================
// 启动
// ================================================================================
setupLogin();
verifyAuthToken().then(function (info) {
  if (info && info.authRequired && !info.authed) showLogin();
});
setupSheet();
setupKeyboard();
connectWs();
renderWelcome();
renderSessionList();

$('tb-menu').onclick = openDrawer;
$('drawer-close').onclick = closeDrawer;
$('drawer-backdrop').onclick = closeDrawer;
$('tb-settings').onclick = openSettings;
$('tb-wins').onclick = openWindowTray;
$('btn-new').onclick = newSession;
$('send-btn').onclick = send;
const input = $('input');
input.addEventListener('input', autoGrow);
input.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
input.addEventListener('focus', function () { setTimeout(scrollMessages, 320); });

fetch('/api/ui-state', { headers: authHeaders() }).then(function (r) { return r.json(); }).then(function (r) {
  if (r && r.theme) { uiState = r; applyUiState(); }
}).catch(function () {});

dispatch('cap.session', { action: 'getCurrent' }).then(function (data) {
  const id = data && data.currentId; if (!id) return;
  if (sessionExplicit) return; // 用户已显式操作会话, 迟到的启动响应不覆盖
  setSessionId(id); renderSessionList();
  loadSessionIntoChat(id);
}).catch(function () {});

dispatch('cap.shell', { action: 'info' }).then(function (info) {
  if (info && info.caps !== undefined) $('cap-badge').textContent = info.caps + ' caps';
}).catch(function () {});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
}
</script>
</body>
</html>`;
