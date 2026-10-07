/**
 * Web Shell — 对齐 Polaris 布局范式
 *
 * 布局: TopBar + ActivityBar(36px) + LeftPanel(可切换保活) + CenterStage(聊天/编辑) + RightPanel(常驻)
 * 响应式: 断点 500px, 小屏 compact 模式 (ActivityBar 折叠 + LeftPanel 抽屉)
 * 保活: 面板用 hidden 属性切换, children DOM 保留, 状态不丢
 * AI 演化: cap.ui.* 改 UI State → WS ui.update → 热重渲染
 */

export const SHELL_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#0a0e27">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Sky · Capability OS</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  html, body { height: 100%; overscroll-behavior: none; }
  body {
    font: 16px/1.5 var(--sky-font, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    background: var(--sky-bg, #0d1117); color: var(--sky-text, #c9d1d9);
    overflow: hidden;
    --safe-top: env(safe-area-inset-top, 0px);
    --safe-bottom: env(safe-area-inset-bottom, 0px);
  }

  /* ============ 布局骨架 (对齐 Polaris: Layout > TopBar + flex(ActivityBar|LeftPanel|CenterStage|RightPanel)) ============ */
  #sky-root {
    display: flex; flex-direction: column; height: 100vh; height: 100dvh;
  }

  /* --- 认证登录覆盖层 --- */
  #auth-overlay {
    position: fixed; inset: 0; z-index: 100;
    background: rgba(0,0,0,0.75); backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center;
  }
  #auth-overlay .auth-card {
    background: var(--sky-bg-elevated, #161b22);
    border: 1px solid var(--sky-border, #21262d);
    border-radius: 12px; padding: 28px; width: min(420px, calc(100vw - 32px));
    box-shadow: 0 16px 48px rgba(0,0,0,0.5);
  }
  #auth-overlay h2 { margin: 0 0 8px; font-size: 17px; color: var(--sky-text, #c9d1d9); }
  #auth-overlay p { margin: 0 0 16px; font-size: 13px; line-height: 1.6; color: var(--sky-text-muted, #8b949e); }
  #auth-overlay input {
    width: 100%; padding: 10px 12px; margin-bottom: 12px;
    background: var(--sky-bg, #0d1117); color: var(--sky-text, #c9d1d9);
    border: 1px solid var(--sky-border, #21262d); border-radius: 8px;
    font-size: 13px; box-sizing: border-box;
  }
  #auth-overlay input:focus { outline: none; border-color: var(--sky-accent, #58a6ff); }

  /* --- 安全设置 token 列表 --- */
  .tok-item {
    display: flex; align-items: center; gap: 8px; padding: 10px 12px; margin-bottom: 8px;
    background: var(--sky-bg-elevated, #161b22); border: 1px solid var(--sky-border, #21262d); border-radius: 6px;
  }
  .tok-item .tok-info { flex: 1; overflow: hidden; }
  .tok-item .tok-name { font-size: 13px; color: var(--sky-text, #c9d1d9); }
  .tok-item .tok-meta { font-size: 11px; color: var(--sky-text-muted, #8b949e); }
  .tok-item .tok-state { font-size: 10px; padding: 1px 6px; border-radius: 4px; }
  .tok-item .tok-state.ok { background: rgba(46,160,67,0.15); color: #3fb950; }
  .tok-item .tok-state.bad { background: rgba(248,81,73,0.15); color: #f85149; }
  .tok-raw {
    padding: 10px 12px; margin-bottom: 12px; font-family: ui-monospace, monospace; font-size: 12px;
    background: rgba(88,166,255,0.08); border: 1px dashed var(--sky-accent, #58a6ff); border-radius: 6px;
    color: var(--sky-text, #c9d1d9); word-break: break-all; line-height: 1.6;
  }

  /* --- TopBar (顶部全局栏) --- */
  #sky-topbar {
    display: flex; align-items: center; gap: 8px;
    padding: calc(var(--safe-top) + 8px) 12px 8px;
    background: var(--sky-bg-elevated, #161b22);
    border-bottom: 1px solid var(--sky-border, #21262d);
    flex-shrink: 0; height: 40px;
  }
  #sky-topbar .title { font-weight: 600; font-size: 14px; flex: 1; }
  #sky-topbar .badge {
    font-size: 11px; color: var(--sky-text-muted, #8b949e);
    background: var(--sky-bg, #0d1117); padding: 2px 8px; border-radius: 10px;
  }
  #sky-topbar .topbar-btn {
    background: none; border: none; color: var(--sky-text-muted, #8b949e);
    cursor: pointer; padding: 4px 8px; border-radius: 4px; font-size: 13px;
    display: flex; align-items: center; gap: 4px;
  }
  #sky-topbar .topbar-btn:hover { color: var(--sky-text, #c9d1d9); background: rgba(255,255,255,0.06); }
  #sky-topbar #tb-workspace { max-width: 200px; overflow: hidden; }
  #sky-topbar #tb-workspace #ws-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 120px; }

  /* 工作区下拉菜单 */
  .ws-dropdown {
    position: absolute; top: 40px; right: 12px; z-index: 60;
    background: var(--sky-bg-elevated, #161b22);
    border: 1px solid var(--sky-border, #21262d);
    border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    min-width: 260px; max-width: 360px; max-height: 400px; overflow-y: auto;
    display: none; flex-direction: column;
  }
  .ws-dropdown.open { display: flex; }
  .ws-dropdown-header { padding: 8px 12px; border-bottom: 1px solid var(--sky-border, #21262d); font-size: 11px; text-transform: uppercase; color: var(--sky-text-muted, #8b949e); letter-spacing: 0.5px; }
  .ws-item {
    display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer;
    border: none; background: none; width: 100%; text-align: left;
    color: var(--sky-text, #c9d1d9); font-size: 13px;
  }
  .ws-item:hover { background: rgba(255,255,255,0.06); }
  .ws-item.active { background: rgba(88,166,255,0.12); color: var(--sky-accent, #58a6ff); }
  .ws-item .ws-info { flex: 1; overflow: hidden; }
  .ws-item .ws-info .ws-title { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ws-item .ws-info .ws-root { font-size: 10px; color: var(--sky-text-muted, #8b949e); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ws-item .ws-del { color: var(--sky-text-muted, #8b949e); padding: 2px 4px; border-radius: 4px; }
  .ws-item .ws-del:hover { color: var(--sky-danger, #f85149); }
  .ws-dropdown-footer { padding: 8px 12px; border-top: 1px solid var(--sky-border, #21262d); display: flex; gap: 8px; }
  .ws-dropdown-footer .btn { width: auto; padding: 6px 12px; min-height: 32px; font-size: 12px; }

  /* 文件树 */
  .fs-tree { font-size: 12px; }
  .fs-node {
    display: flex; align-items: center; gap: 4px; padding: 3px 6px; cursor: pointer;
    color: var(--sky-text, #c9d1d9); border-radius: 4px;
  }
  .fs-node:hover { background: rgba(255,255,255,0.06); }
  .fs-node .fs-icon { width: 14px; height: 14px; flex-shrink: 0; opacity: 0.7; }
  .fs-node .fs-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fs-node.dir .fs-icon { color: var(--sky-accent, #58a6ff); }
  .fs-children { margin-left: 16px; }
  .fs-children.collapsed { display: none; }

  /* --- 主布局横向容器 --- */
  #sky-main { display: flex; flex: 1; overflow: hidden; position: relative; }

  /* --- ActivityBar (左侧图标栏, 36px) --- */
  #activity-bar {
    width: 36px; flex-shrink: 0;
    display: flex; flex-direction: column; align-items: center;
    background: var(--sky-bg-elevated, #161b22);
    border-right: 1px solid var(--sky-border, #21262d);
    padding: 8px 0; gap: 2px;
    overflow: hidden;
  }
  .ab-icon {
    width: 28px; height: 28px;
    display: flex; align-items: center; justify-content: center;
    border: none; background: none; cursor: pointer;
    color: var(--sky-text-muted, #8b949e);
    border-radius: 6px; flex-shrink: 0;
    transition: color .15s, background-color .15s;
  }
  .ab-icon:hover { color: var(--sky-text, #c9d1d9); background: rgba(255,255,255,0.06); }
  .ab-icon.active { color: var(--sky-accent, #58a6ff); background: rgba(88,166,255,0.12); }
  .ab-icon svg { width: 18px; height: 18px; display: block; }
  .ab-divider { width: 20px; height: 1px; background: var(--sky-border, #21262d); margin: 4px 0; flex-shrink: 0; }
  .ab-spacer { flex: 1; }

  /* --- LeftPanel (可切换面板, 保活) --- */
  #left-panel {
    width: var(--lp-width, 240px); flex-shrink: 0;
    background: var(--sky-bg, #0d1117);
    border-right: 1px solid var(--sky-border, #21262d);
    overflow: hidden; position: relative;
    display: flex; flex-direction: column;
  }
  #left-panel.hidden { width: 0; border-right: none; }
  .lp-content { display: none; flex-direction: column; flex: 1; overflow: hidden; }
  .lp-content:not([hidden]) { display: flex; }
  .lp-header {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; border-bottom: 1px solid var(--sky-border, #21262d);
    flex-shrink: 0; height: 36px;
  }
  .lp-header .lp-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--sky-text-muted, #8b949e); flex: 1; }
  .lp-header .lp-btn {
    background: none; border: none; color: var(--sky-text-muted, #8b949e);
    cursor: pointer; padding: 2px 6px; border-radius: 4px; font-size: 13px;
  }
  .lp-header .lp-btn:hover { color: var(--sky-text, #c9d1d9); background: rgba(255,255,255,0.06); }
  .lp-body { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 12px; }
  .lp-body.slim { padding: 8px; }

  /* --- CenterStage (中间主视野, flex-1) --- */
  #center-stage {
    flex: 1; display: flex; flex-direction: column;
    overflow: hidden; background: var(--sky-bg, #0d1117);
    min-width: 0;
  }
  #cs-topbar {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 12px; border-bottom: 1px solid var(--sky-border, #21262d);
    flex-shrink: 0; height: 36px; background: var(--sky-bg-elevated, #161b22);
  }
  #cs-topbar .ct-title { flex: 1; font-size: 12px; color: var(--sky-text-muted, #8b949e); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #cs-topbar .ct-btn {
    background: none; border: none; color: var(--sky-text-muted, #8b949e);
    cursor: pointer; padding: 4px 8px; border-radius: 4px; font-size: 12px;
  }
  #cs-topbar .ct-btn:hover { color: var(--sky-text, #c9d1d9); background: rgba(255,255,255,0.06); }

  /* --- RightPanel (右侧常驻栏) --- */
  #right-panel {
    width: var(--rp-width, 320px); flex-shrink: 0;
    background: var(--sky-bg-elevated, #161b22);
    border-left: 1px solid var(--sky-border, #21262d);
    display: flex; flex-direction: column; overflow: hidden;
  }
  #right-panel.collapsed { width: 0; border-left: none; }

  /* --- 设置覆盖层 (absolute, 主布局 inert) --- */
  #settings-overlay {
    position: absolute; inset: 0; z-index: 50;
    background: var(--sky-bg, #0d1117);
    display: none; flex-direction: column;
  }
  #settings-overlay.open { display: flex; }
  #settings-header {
    display: flex; align-items: center; gap: 8px;
    padding: calc(var(--safe-top) + 8px) 12px 8px;
    border-bottom: 1px solid var(--sky-border, #21262d);
    flex-shrink: 0; height: 40px; background: var(--sky-bg-elevated, #161b22);
  }
  #settings-header .s-title { font-weight: 600; font-size: 14px; flex: 1; }
  #settings-header .s-close {
    background: none; border: none; color: var(--sky-text-muted, #8b949e);
    cursor: pointer; padding: 4px 8px; border-radius: 4px; font-size: 16px;
  }
  #settings-body { flex: 1; display: flex; overflow: hidden; }
  #settings-tabs {
    width: 180px; flex-shrink: 0; padding: 8px 0;
    border-right: 1px solid var(--sky-border, #21262d);
    background: var(--sky-bg, #0d1117); overflow-y: auto;
  }
  .s-tab {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; cursor: pointer; font-size: 13px;
    color: var(--sky-text-muted, #8b949e); border: none; background: none;
    width: 100%; text-align: left;
  }
  .s-tab:hover { color: var(--sky-text, #c9d1d9); background: rgba(255,255,255,0.04); }
  .s-tab.active { color: var(--sky-accent, #58a6ff); background: rgba(88,166,255,0.08); border-left: 2px solid var(--sky-accent, #58a6ff); }
  #settings-content { flex: 1; overflow-y: auto; padding: 16px; }

  /* ============ 组件样式 ============ */
  h2 { font-size: 13px; text-transform: uppercase; color: var(--sky-text-muted, #8b949e); letter-spacing: 0.5px; margin-bottom: 8px; }
  .cap-item {
    background: var(--sky-bg-elevated, #161b22);
    padding: 10px 12px; border-radius: 6px; margin-bottom: 8px; font-size: 13px;
  }
  .cap-id { color: var(--sky-accent, #58a6ff); font-family: var(--sky-mono, ui-monospace, monospace); font-size: 13px; }
  .cap-desc { color: var(--sky-text-muted, #8b949e); margin-top: 2px; font-size: 12px; }
  .tag { display: inline-block; padding: 1px 6px; border-radius: 8px; background: var(--sky-primary, #1f6feb); color: #fff; font-size: 10px; margin-left: 6px; }

  /* 聊天: 消息 */
  #cs-messages {
    flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch;
    padding: 16px; display: flex; flex-direction: column;
    gap: var(--chat-gap, 10px); font-size: var(--chat-fontsize, 15px);
  }
  .msg {
    padding: 10px 14px; border-radius: 6px;
    word-wrap: break-word; overflow-wrap: break-word; white-space: pre-wrap;
    line-height: 1.55; max-width: var(--msg-user-maxw, 85%);
  }
  .msg.user {
    background: var(--sky-primary, #1f6feb); color: #fff;
    margin-left: auto; border-bottom-right-radius: 3px;
  }
  .msg.assistant {
    background: var(--sky-bg-elevated, #161b22);
    color: var(--sky-text, #c9d1d9);
    border-bottom-left-radius: 3px;
    max-width: var(--msg-assistant-maxw, 100%); width: 100%;
  }
  .msg.assistant code:not(pre code) {
    background: var(--sky-bg, #0d1117); padding: 1px 5px; border-radius: 3px;
    font-family: var(--sky-mono, monospace); font-size: 0.9em;
  }
  .msg.assistant pre {
    background: var(--sky-bg, #0d1117); padding: 10px 12px; border-radius: 4px;
    overflow-x: auto; margin: 6px 0; border: 1px solid var(--sky-border, #21262d);
  }
  .msg.assistant pre code { font-family: var(--sky-mono, monospace); font-size: 0.88em; white-space: pre; }
  .msg.assistant strong { font-weight: 600; }
  .msg.assistant p { margin: 0; }
  .msg.assistant p + p { margin-top: 8px; }

  /* 工具块 (调用 + 结果合并, 可折叠) */
  .tool-block {
    border-left: 3px solid var(--sky-text-muted, #8b949e);
    background: var(--sky-bg, #0d1117);
    border-radius: 0 4px 4px 0; margin: 6px 0;
    font-family: var(--sky-mono, monospace); font-size: 12px;
    overflow: hidden; transition: border-color .2s, background-color .2s;
  }
  .tool-block.running { border-left-color: var(--sky-warning, #f0883e); }
  .tool-block.ok { border-left-color: var(--sky-success, #238636); }
  .tool-block.err { border-left-color: var(--sky-danger, #f85149); }
  .tool-block.card {
    border: 1px solid var(--sky-border, #21262d); border-left-width: 3px;
    background: var(--sky-bg-elevated, #161b22); border-radius: 8px;
  }
  .tool-block.running.card { border-color: rgba(255,255,255,0.15); }
  .tool-head {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px; cursor: pointer; user-select: none;
    color: var(--sky-text, #c9d1d9); font-size: 12px; line-height: 1.2;
    min-height: 36px;
  }
  .tool-head:hover { background: rgba(255,255,255,0.04); }
  .tool-head .tool-icon { flex-shrink: 0; color: var(--sky-text-muted, #8b949e); width: 14px; height: 14px; display: block; }
  .tool-block.running .tool-head .tool-icon { color: var(--sky-warning, #f0883e); animation: tool-spin 1s linear infinite; }
  .tool-block.ok .tool-head .tool-icon { color: var(--sky-success, #238636); }
  .tool-block.err .tool-head .tool-icon { color: var(--sky-danger, #f85149); }
  @keyframes tool-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
  .tool-head .tool-name { color: var(--sky-accent, #58a6ff); font-weight: 500; flex-shrink: 0; font-size: 12px; }
  .tool-head .tool-summary {
    color: var(--sky-text-muted, #8b949e); overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; font-size: 12px;
  }
  .tool-head .tool-chev { flex-shrink: 0; color: var(--sky-text-muted, #8b949e); transition: transform .2s; width: 12px; height: 12px; display: block; }
  .tool-block.expanded .tool-chev { transform: rotate(90deg); }
  .tool-body {
    display: none; padding: 12px 16px; border-top: 1px solid var(--sky-border, #21262d);
    max-height: 320px; overflow-y: auto;
  }
  .tool-block.expanded .tool-body { display: block; }
  .tool-block.folded .tool-body { display: none; }
  .tool-block.folded.expanded .tool-body { display: block; }
  .tool-block.folded .tool-chev { transform: rotate(0); }
  .tool-block.folded.expanded .tool-chev { transform: rotate(90deg); }
  .tool-body .tool-section {
    color: var(--sky-text-muted, #8b949e); font-size: 10px;
    text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 3px; margin-top: 6px;
  }
  .tool-body .tool-section:first-child { margin-top: 0; }
  .tool-body .tool-json { white-space: pre-wrap; word-break: break-all; color: var(--sky-text, #c9d1d9); }
  .tool-body .tool-result-ok { color: var(--sky-success, #238636); }
  .tool-body .tool-result-err { color: var(--sky-danger, #f85149); }

  .tool-group-more {
    display: flex; align-items: center; gap: 6px; margin: 6px 0; padding: 8px 12px;
    background: var(--sky-bg, #0d1117); border: 1px dashed var(--sky-border, #21262d);
    border-radius: 8px; cursor: pointer; user-select: none;
    color: var(--sky-text-muted, #8b949e); font-size: 12px; min-height: 36px;
    transition: background-color .15s, border-color .15s, color .15s;
  }
  .tool-group-more:hover { background: rgba(255,255,255,0.04); border-color: var(--sky-accent, #58a6ff); color: var(--sky-accent, #58a6ff); }
  .tool-group-more svg { width: 14px; height: 14px; flex-shrink: 0; }
  .tool-group-more .more-count { font-size: 10px; padding: 1px 6px; border-radius: 8px; background: var(--sky-bg-elevated, #161b22); color: var(--sky-text, #c9d1d9); margin-left: auto; }
  .tool-block.folded-hidden { display: none; }
  .tool-group.expanded .tool-block.folded-hidden { display: block; }
  .tool-group.expanded .tool-group-more { display: none; }

  #input-bar {
    display: flex; gap: 8px; padding: 10px 12px;
    border-top: 1px solid var(--sky-border, #21262d);
    background: var(--sky-bg-elevated, #161b22); flex-shrink: 0;
  }
  #input {
    flex: 1; background: var(--sky-bg-input, #0d1117);
    border: 1px solid var(--sky-border, #21262d); color: var(--sky-text, #c9d1d9);
    border-radius: 20px; padding: 10px 16px; font: inherit; font-size: 16px; min-height: 44px;
  }
  #input:focus { outline: none; border-color: var(--sky-accent, #58a6ff); }
  #send-btn {
    background: var(--sky-success, #238636); color: #fff; border: none;
    border-radius: 20px; padding: 0 18px; min-height: 44px; min-width: 60px;
    cursor: pointer; font: inherit; font-size: 15px;
    display: flex; align-items: center; justify-content: center; gap: 6px;
  }
  #send-btn svg { width: 16px; height: 16px; }
  #send-btn:disabled { opacity: 0.5; }

  .field { margin-bottom: 12px; }
  .field label { display: block; font-size: 12px; color: var(--sky-text-muted, #8b949e); margin-bottom: 4px; }
  .field input, .field select {
    width: 100%; background: var(--sky-bg-input, #0d1117);
    border: 1px solid var(--sky-border, #21262d); color: var(--sky-text, #c9d1d9);
    border-radius: 4px; padding: 10px 12px; font: inherit; font-size: 16px; min-height: 44px;
  }
  .btn {
    background: var(--sky-primary, #1f6feb); color: #fff; border: none;
    border-radius: 4px; padding: 10px 16px; min-height: 44px;
    cursor: pointer; font: inherit; font-size: 15px; width: 100%;
  }
  .btn.secondary { background: var(--sky-border, #21262d); color: var(--sky-text, #c9d1d9); }
  .status { font-size: 12px; color: var(--sky-text-muted, #8b949e); margin-top: 8px; min-height: 18px; }
  .status.ok { color: var(--sky-success, #238636); }
  .status.err { color: var(--sky-danger, #f85149); }

  /* 会话列表 */
  .sess-list { display: flex; flex-direction: column; gap: 6px; }
  .sess-item {
    background: var(--sky-bg-elevated, #161b22);
    border: 1px solid var(--sky-border, #21262d);
    border-radius: 6px; padding: 8px 10px; cursor: pointer; min-height: 44px;
  }
  .sess-item:hover { border-color: var(--sky-accent, #58a6ff); }
  .sess-item.active { border-color: var(--sky-accent, #58a6ff); background: rgba(31,111,235,0.15); }
  .sess-title {
    font-size: 13px; color: var(--sky-text, #c9d1d9); line-height: 1.3;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .sess-meta {
    font-size: 11px; color: var(--sky-text-muted, #8b949e); margin-top: 4px;
    display: flex; gap: 8px; align-items: center;
  }
  .sess-del { margin-left: auto; color: var(--sky-text-muted, #8b949e); }
  .sess-del:hover { color: var(--sky-danger, #f85149); }
  .sess-empty {
    color: var(--sky-text-muted, #8b949e); font-size: 12px;
    padding: 16px 0; text-align: center; line-height: 1.6;
  }

  /* AI 注入的自定义组件容器 */
  .sky-custom-comp {
    margin: 12px 0; padding: 10px 12px;
    border: 1px dashed var(--sky-border, #21262d); border-radius: 8px;
  }
  .sky-custom-zone { margin-top: 16px; }

  /* ============ 响应式: compact 模式 (断点 500px, 对齐原 Polaris) ============ */
  @media (max-width: 500px) {
    #sky-topbar { height: auto; padding: calc(var(--safe-top) + 6px) 8px 6px; }
    #activity-bar { width: 28px; }
    .ab-icon { width: 24px; height: 24px; }
    .ab-icon svg { width: 16px; height: 16px; }
    #left-panel {
      position: fixed; inset: 0 auto 0 36px; z-index: 40; width: min(85vw, 320px);
      box-shadow: 4px 0 24px rgba(0,0,0,0.4);
    }
    #left-panel.hidden { display: none; }
    .lp-backdrop {
      position: fixed; inset: 0; z-index: 35; background: rgba(0,0,0,0.5);
      display: none;
    }
    .lp-backdrop.show { display: block; }
    #right-panel { width: 100%; border-left: none; }
    #right-panel.collapsed { width: 100%; }
    #input-bar { padding-bottom: calc(10px + var(--safe-bottom)); }
  }
</style>
<style id="sky-dynamic"></style>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="ic-caps" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/>
  </symbol>
  <symbol id="ic-chat" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </symbol>
  <symbol id="ic-settings" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </symbol>
  <symbol id="ic-tool" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
  </symbol>
  <symbol id="ic-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="9 18 15 12 9 6"/>
  </symbol>
  <symbol id="ic-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </symbol>
  <symbol id="ic-x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </symbol>
  <symbol id="ic-loader" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/>
    <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/>
    <line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/>
    <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>
  </symbol>
  <symbol id="ic-send" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
  </symbol>
  <symbol id="ic-menu" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>
  </symbol>
  <symbol id="ic-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </symbol>
  <symbol id="ic-sessions" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </symbol>
  <symbol id="ic-files" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
  </symbol>
</svg>
<div id="sky-root">
  <div id="sky-topbar">
    <button class="topbar-btn" id="tb-menu" title="菜单"><svg width="18" height="18"><use href="#ic-menu"/></svg></button>
    <span class="title">Sky</span>
    <button class="topbar-btn" id="tb-workspace" title="工作区">
      <svg width="16" height="16"><use href="#ic-files"/></svg>
      <span id="ws-name">无工作区</span>
      <svg width="12" height="12" style="opacity:.6"><use href="#ic-chev"/></svg>
    </button>
    <span class="badge" id="cap-badge">...</span>
    <button class="topbar-btn" id="tb-settings" title="设置"><svg width="18" height="18"><use href="#ic-settings"/></svg></button>
  </div>
  <div id="sky-main">
    <div id="activity-bar"></div>
    <div class="lp-backdrop" id="lp-backdrop"></div>
    <div id="left-panel">
      <div class="lp-content" data-key="sessions" id="lp-sessions"></div>
      <div class="lp-content" data-key="files" id="lp-files" hidden></div>
      <div class="lp-content" data-key="caps" id="lp-caps" hidden></div>
    </div>
    <div id="center-stage">
      <div id="cs-topbar">
        <span class="ct-title" id="ct-title">新会话 (发送后自动保存)</span>
        <button class="ct-btn" id="ct-new">新会话</button>
      </div>
      <div id="cs-messages">
        <div class="msg assistant">Sky 能力 OS. AI 可调用所有 cap 含 UI 演进. 试试: "把主题换成 midnight" 或 "改聊天字号 18px"</div>
      </div>
      <div id="input-bar">
        <input id="input" type="text" placeholder="发送消息..." autocomplete="off" enterkeyhint="send">
        <button id="send-btn"><svg><use href="#ic-send"/></svg></button>
      </div>
    </div>
    <div id="right-panel"></div>
  </div>
  <div id="settings-overlay">
    <div id="settings-header">
      <span class="s-title">设置</span>
      <button class="s-close" id="s-close"><svg width="20" height="20"><use href="#ic-close"/></svg></button>
    </div>
    <div id="settings-body">
      <div id="settings-tabs"></div>
      <div id="settings-content"></div>
    </div>
  </div>
  <div class="ws-dropdown" id="ws-dropdown"></div>
  <div id="auth-overlay" style="display:none">
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
// 状态机 (替代 zustand)
// ================================================================================
const state = {
  activeLeftPanel: 'sessions',
  leftPanelVisible: true,
  rightPanelCollapsed: false,
  isCompact: window.innerWidth < 500,
  settingsOpen: false,
  settingsTab: 'general',
  theme: 'dark',
};
const $ = id => document.getElementById(id);
const dynamicStyle = $('sky-dynamic');
let ws = null;
let currentStreamId = null;
let currentMsgEl = null;
const pendingEvents = [];
const pendingDispatch = [];
let uiState = null;
let streamingNotifyShown = false;
let dispatchSeq = 0;

// ================================================================================
// dispatch 助手 (走 HTTP, 与聊天同通路)
// ================================================================================
function dispatch(cap, params) {
  return fetch('/api/dispatch', {
    method: POST_METHOD, headers: authHeaders(),
    body: JSON.stringify({ cap, params, reqId: 'h-' + (++dispatchSeq) }),
  }).then(r => {
    if (r.status === 401) { showLogin(); return { result: { data: null } }; }
    return r.json();
  }).then(r => r.result?.data ?? null).catch(e => {
    console.warn('[dispatch] ' + cap, e); return null;
  });
}
const POST_METHOD = 'POST';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ================================================================================
// 认证 — token 存 localStorage, 请求附带 Bearer; 401 → 登录覆盖层
// ================================================================================
const AUTH_KEY = 'sky_token';
function storedToken() { try { return localStorage.getItem(AUTH_KEY) || ''; } catch { return ''; } }
function saveToken(t) { try { t ? localStorage.setItem(AUTH_KEY, t) : localStorage.removeItem(AUTH_KEY); } catch {} }
function authHeaders() {
  const t = storedToken();
  return t ? { ...JSON_HEADERS, 'Authorization': 'Bearer ' + t } : JSON_HEADERS;
}
let authInfo = null; // { authRequired, authed, authName, admin }
async function verifyAuthToken() {
  try {
    const r = await fetch('/api/auth/verify', { headers: authHeaders() });
    authInfo = await r.json();
  } catch { authInfo = null; }
  return authInfo;
}
function showLogin() {
  const ov = $('auth-overlay');
  if (!ov) return;
  ov.style.display = 'flex';
  const inp = $('auth-token-input');
  if (inp) setTimeout(() => inp.focus(), 50);
}
function hideLogin() { const ov = $('auth-overlay'); if (ov) ov.style.display = 'none'; }
function setupLogin() {
  const btn = $('auth-login-btn');
  const inp = $('auth-token-input');
  if (!btn || !inp) return;
  const tryLogin = async () => {
    const t = inp.value.trim();
    if (!t) return;
    saveToken(t);
    const info = await verifyAuthToken();
    const s = $('auth-status');
    if (info && info.authed) {
      hideLogin(); location.reload();
    } else {
      saveToken('');
      if (s) { s.textContent = 'token 无效或已吊销'; s.className = 'status err'; }
    }
  };
  btn.onclick = tryLogin;
  inp.onkeydown = (e) => { if (e.key === 'Enter') tryLogin(); };
}

function setSessionEl(id) { const el = $('session-id'); if (el) el.value = id || ''; }
function curSessionId() { const el = $('session-id'); return (el && el.value) || ''; }
function setSessionId(id) { setSessionEl(id); updateChatTopbar(); }
function updateChatTopbar() {
  const id = curSessionId(); const t = $('ct-title');
  if (t) t.textContent = id ? id : '新会话 (发送后自动保存)';
}
function clearChat() {
  const m = $('cs-messages'); if (m) m.innerHTML = '<div class="msg assistant">新会话已创建. 开始聊吧.</div>';
}
function openChat() { /* CenterStage 始终可见, 无需切页 */ }

// ================================================================================
// ActivityBar 注册制 (对齐原 Polaris pluginRegistry.listViewContributions)
// ================================================================================
const activityBarItems = [
  { id: 'sessions', icon: 'ic-sessions', label: '会话', panel: 'sessions' },
  { id: 'files', icon: 'ic-files', label: '文件', panel: 'files' },
  { id: 'caps', icon: 'ic-caps', label: '能力', panel: 'caps' },
];
function renderActivityBar() {
  const bar = $('activity-bar'); if (!bar) return;
  bar.innerHTML = activityBarItems.map(it =>
    '<button class="ab-icon' + (state.activeLeftPanel === it.panel && state.leftPanelVisible ? ' active' : '') + '" data-panel="' + it.panel + '" title="' + it.label + '">' +
    '<svg><use href="#' + it.icon + '"/></svg></button>'
  ).join('') + '<div class="ab-spacer"></div><div class="ab-divider"></div>' +
    '<button class="ab-icon" id="ab-settings" title="设置"><svg><use href="#ic-settings"/></svg></button>';
  bar.querySelectorAll('.ab-icon[data-panel]').forEach(btn => {
    btn.onclick = () => toggleLeftPanel(btn.dataset.panel);
  });
  $('ab-settings').onclick = () => openSettings();
}
function toggleLeftPanel(type) {
  if (state.activeLeftPanel === type && state.leftPanelVisible) {
    state.leftPanelVisible = false;
  } else {
    state.activeLeftPanel = type;
    state.leftPanelVisible = true;
  }
  applyLeftPanel();
}
function applyLeftPanel() {
  const lp = $('left-panel'); const backdrop = $('lp-backdrop');
  if (!state.leftPanelVisible) {
    lp.classList.add('hidden'); backdrop.classList.remove('show'); renderActivityBar(); return;
  }
  lp.classList.remove('hidden');
  document.querySelectorAll('.lp-content').forEach(el => { el.hidden = el.dataset.key !== state.activeLeftPanel; });
  if (state.isCompact) backdrop.classList.add('show'); else backdrop.classList.remove('show');
  renderActivityBar();
}
$('lp-backdrop').addEventListener('click', () => { state.leftPanelVisible = false; applyLeftPanel(); });

// ================================================================================
// 会话列表 (内置组件, 渲染到 LeftPanel 的 sessions content)
// ================================================================================
function renderSessionList() {
  const el = $('lp-sessions'); if (!el) return;
  el.innerHTML = '<div class="lp-header"><span class="lp-title">会话</span>' +
    '<button class="lp-btn" id="sess-refresh">刷新</button>' +
    '<button class="lp-btn" id="sess-new">新建</button></div>' +
    '<div class="lp-body"><div class="sess-list" id="sess-list"><div style="color:var(--sky-text-muted,#8b949e);font-size:12px;padding:8px 0">加载中...</div></div></div>';
  $('sess-new').onclick = newSession;
  $('sess-refresh').onclick = renderSessionList;
  $('sess-list').onclick = (e) => {
    const del = e.target.closest('[data-del]'); if (del) { e.stopPropagation(); deleteSession(del.dataset.del); return; }
    const item = e.target.closest('[data-sid]'); if (item) switchSession(item.dataset.sid);
  };
  dispatch('cap.session', { action: 'list', limit: 100 }).then(data => {
    const sessions = (data && data.sessions) || []; const cur = data && data.currentId;
    const host = $('sess-list'); if (!host) return;
    if (!sessions.length) { host.innerHTML = '<div class="sess-empty">暂无会话<br>新建后自动出现在这里</div>'; return; }
    host.innerHTML = sessions.map(s => {
      const d = new Date(s.lastActive || s.createdAt || Date.now());
      const stamp = (d.getMonth()+1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
      return '<div class="sess-item' + (s.id === cur ? ' active' : '') + '" data-sid="' + esc(s.id) + '">' +
        '<div class="sess-title">' + esc(s.title || s.id) + '</div>' +
        '<div class="sess-meta"><span>' + (s.messages||0) + ' 条</span><span>' + stamp + '</span>' +
        '<span class="sess-del" data-del="' + esc(s.id) + '" title="删除"><svg class="icon" width="14" height="14"><use href="#ic-x"/></svg></span></div></div>';
    }).join('');
  });
}
async function newSession() {
  const data = await dispatch('cap.session', { action: 'create' });
  if (data && data.id) { setSessionId(data.id); }
  renderSessionList();
}
async function switchSession(id) {
  await dispatch('cap.session', { action: 'switch', sessionId: id });
  loadSessionIntoChat(id); renderSessionList();
}
async function deleteSession(id) {
  const confirmed = window.confirm('删除该会话? 聊天记录将一并删除'); if (!confirmed) return;
  const data = await dispatch('cap.session', { action: 'delete', sessionId: id });
  if (data && data.wasCurrent) { setSessionId(''); clearChat(); }
  renderSessionList();
}
async function loadSessionIntoChat(id, keep) {
  setSessionId(id); const msgs = $('cs-messages'); if (!msgs) return;
  if (keep) { await dispatch('cap.history', { action: 'list', sessionId: id }).catch(()=>{}); return; }
  const data = await dispatch('cap.history', { action: 'list', sessionId: id });
  const hist = (data && data.messages) || [];
  msgs.innerHTML = hist.map(m => '<div class="msg ' + (m.role === 'user' ? 'user' : 'assistant') + '">' + esc(String(m.content || '')) + '</div>').join('') ||
    '<div class="msg assistant">已切换到该会话. 继续聊吧.</div>';
  scrollMessages();
}
async function ensureSession(title) {
  const cur = curSessionId();
  if (cur) { await dispatch('cap.session', { action: 'switch', sessionId: cur }); return cur; }
  const t = title && title.trim() ? title.trim().slice(0, 40) : '会话 ' + new Date().toLocaleString();
  const data = await dispatch('cap.session', { action: 'create', title: t });
  const id = data && data.id; if (!id) return '';
  setSessionId(id); renderSessionList(); return id;
}

// ================================================================================
// 工作区管理 (TopBar 选择器 + 下拉菜单)
// ================================================================================
let currentWorkspace = null; // { id, name, root, absolute }

async function refreshWorkspace() {
  const data = await dispatch('cap.workspace', { action: 'get', includeTree: false });
  if (data && data.ok !== false && data.id) {
    currentWorkspace = { id: data.id, name: data.name, root: data.root, absolute: data.absolute };
  } else {
    currentWorkspace = null;
  }
  updateWorkspaceDisplay();
  renderFileList();
}

function updateWorkspaceDisplay() {
  const nameEl = $('ws-name');
  if (nameEl) nameEl.textContent = currentWorkspace ? currentWorkspace.name : '无工作区';
}

function toggleWorkspaceDropdown() {
  const dd = $('ws-dropdown');
  if (dd.classList.contains('open')) { dd.classList.remove('open'); return; }
  renderWorkspaceDropdown();
  dd.classList.add('open');
}

async function renderWorkspaceDropdown() {
  const dd = $('ws-dropdown');
  dd.innerHTML = '<div class="ws-dropdown-header">工作区</div><div id="ws-list" style="padding:4px 0"><div style="padding:8px 12px;color:var(--sky-text-muted,#8b949e);font-size:12px">加载中...</div></div>' +
    '<div class="ws-dropdown-footer"><button class="btn secondary" id="ws-add-input">从路径添加</button></div>';
  $('ws-add-input').onclick = () => {
    const root = window.prompt('输入工作区根目录 (绝对路径, 如 D:\\\\proj\\\\my-app)');
    if (root && root.trim()) addWorkspaceFromPath(root.trim());
  };
  const data = await dispatch('cap.workspace', { action: 'list' });
  const list = $('ws-list');
  const workspaces = (data && data.workspaces) || [];
  const currentId = (data && data.currentId) || (currentWorkspace ? currentWorkspace.id : null);
  if (!workspaces.length) {
    list.innerHTML = '<div style="padding:12px;color:var(--sky-text-muted,#8b949e);font-size:12px;line-height:1.6;text-align:center">暂无工作区<br>点击「从路径添加」创建</div>';
    return;
  }
  list.innerHTML = workspaces.map(w => {
    const isCurrent = w.id === currentId;
    return '<button class="ws-item' + (isCurrent ? ' active' : '') + '" data-wid="' + esc(w.id) + '">' +
      '<div class="ws-info"><div class="ws-title">' + esc(w.name) + '</div>' +
      '<div class="ws-root">' + esc(w.root) + '</div></div>' +
      '<span class="ws-del" data-wdel="' + esc(w.id) + '" title="删除"><svg width="14" height="14"><use href="#ic-x"/></svg></span></button>';
  }).join('');
  list.querySelectorAll('.ws-item').forEach(btn => {
    btn.onclick = (e) => {
      const del = e.target.closest('[data-wdel]');
      if (del) { e.stopPropagation(); deleteWorkspace(del.dataset.wdel); return; }
      switchWorkspace(btn.dataset.wid);
    };
  });
}

async function addWorkspaceFromPath(root) {
  const name = root.split(/[/\\\\]/).filter(Boolean).pop() || 'workspace';
  const data = await dispatch('cap.workspace', { action: 'set', root, name });
  if (data && data.ok !== false) {
    await refreshWorkspace();
    renderFileList();
    $('ws-dropdown').classList.remove('open');
  } else {
    window.alert('添加工作区失败: ' + (data ? data.error : '未知错误'));
  }
}

async function switchWorkspace(id) {
  const data = await dispatch('cap.workspace', { action: 'switch', id });
  if (data && data.ok !== false) {
    await refreshWorkspace();
    renderFileList();
  }
  $('ws-dropdown').classList.remove('open');
}

async function deleteWorkspace(id) {
  const confirmed = window.confirm('删除工作区记录? (不会删除磁盘文件)');
  if (!confirmed) return;
  await dispatch('cap.workspace', { action: 'delete', id, force: true });
  await refreshWorkspace();
  renderWorkspaceDropdown();
  renderFileList();
}

// ================================================================================
// 文件浏览器 (LeftPanel files content — 接 cap.workspace, 显示当前工作区文件树)
// ================================================================================
async function renderFileList() {
  const el = $('lp-files'); if (!el) return;
  el.innerHTML = '<div class="lp-header"><span class="lp-title">文件</span>' +
    '<button class="lp-btn" id="fs-refresh">刷新</button></div>' +
    '<div class="lp-body"><div id="fs-tree" class="fs-tree" style="color:var(--sky-text-muted,#8b949e);font-size:12px;padding:8px 0">加载中...</div></div>';
  $('fs-refresh').onclick = () => renderFileList();
  const host = $('fs-tree');
  if (!currentWorkspace) {
    host.innerHTML = '<div style="color:var(--sky-text-muted,#8b949e);font-size:12px;line-height:1.6;padding:12px 0;text-align:center">未选择工作区<br>点击顶栏工作区按钮选择</div>';
    return;
  }
  const data = await dispatch('cap.workspace', { action: 'get', includeTree: true });
  if (!data || data.ok === false) {
    host.innerHTML = '<div style="color:var(--sky-text-muted,#8b949e);font-size:12px">读取失败</div>';
    return;
  }
  const tree = data.tree || [];
  if (!tree.length) {
    host.innerHTML = '<div style="color:var(--sky-text-muted,#8b949e);font-size:12px">空目录</div>';
    return;
  }
  host.innerHTML = renderFileTreeNodes(tree);
  host.querySelectorAll('.fs-node.dir').forEach(node => {
    node.onclick = () => {
      const children = node.nextElementSibling;
      if (children && children.classList.contains('fs-children')) children.classList.toggle('collapsed');
    };
  });
}

function renderFileTreeNodes(nodes) {
  return nodes.map(n => {
    const isDir = n.type === 'dir';
    const icon = isDir ? '<svg class="fs-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
      : '<svg class="fs-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    let html = '<div class="fs-node' + (isDir ? ' dir' : '') + '" data-path="' + esc(n.path) + '">' +
      icon + '<span class="fs-name">' + esc(n.name) + '</span></div>';
    if (isDir && n.children && n.children.length > 0) {
      html += '<div class="fs-children">' + renderFileTreeNodes(n.children) + '</div>';
    }
    return html;
  }).join('');
}

// ================================================================================
// 能力列表 (LeftPanel caps content)
// ================================================================================
async function renderCapsList() {
  const el = $('lp-caps'); if (!el) return;
  el.innerHTML = '<div class="lp-header"><span class="lp-title">能力</span></div><div class="lp-body" id="caps-body"></div>';
  const r = await fetch('/api/caps').then(r=>r.json());
  const caps = r.caps || [];
  const badge = $('cap-badge'); if (badge) badge.textContent = caps.length + ' caps';
  const body = $('caps-body');
  if (body) body.innerHTML = caps.map(c =>
    '<div class="cap-item"><div><span class="cap-id">' + c.id + '</span>' +
    (c.streaming ? '<span class="tag">stream</span>' : '') + '</div>' +
    '<div class="cap-desc">' + esc(c.description || '') + '</div></div>'
  ).join('');
}

// ================================================================================
// 聊天 (CenterStage 内)
// ================================================================================
function scrollMessages() { const m = $('cs-messages'); if (m) m.scrollTop = m.scrollHeight; }
const toolBlocks = new Map();
let currentRoundBlocks = [];
function toolBlockKey(name, ev) { return name + '#' + (ev.data?.callSeq ?? ev._seq ?? ''); }
function ensureToolGroup() {
  const messages = $('cs-messages'); if (!messages) return null;
  let group = messages.querySelector('.tool-group:last-child');
  if (!group || group.dataset.closed === '1') { group = document.createElement('div'); group.className = 'tool-group'; messages.appendChild(group); currentRoundBlocks = []; }
  return group;
}
function applyToolGroupFolding(group) {
  const cfg = (uiState && uiState.chat) || {};
  const threshold = cfg.toolCollapseThreshold ?? 5; const maxVisible = cfg.toolMaxVisible ?? 4;
  const blocks = [...group.querySelectorAll('.tool-block')];
  if (blocks.length <= threshold) { blocks.forEach(b => b.classList.remove('folded-hidden')); const more = group.querySelector('.tool-group-more'); if (more) more.remove(); return; }
  const hidden = blocks.slice(maxVisible); hidden.forEach(b => b.classList.add('folded-hidden'));
  let more = group.querySelector('.tool-group-more');
  if (!more) { more = document.createElement('div'); more.className = 'tool-group-more'; more.innerHTML = '<svg><use href="#ic-chev"/></svg><span>展开剩余</span><span class="more-count">0</span>'; more.onclick = () => group.classList.toggle('expanded'); group.appendChild(more); }
  more.querySelector('.more-count').textContent = hidden.length;
}
function addToolCall(ev) {
  const messages = $('cs-messages'); if (!messages) return;
  const cfg = (uiState && uiState.chat) || {};
  const group = ensureToolGroup();
  const seq = (ev.data?.callSeq ?? Date.now().toString(36)); const key = ev.data.name + '#' + seq;
  const argsStr = cfg.toolShowFullArgs ? JSON.stringify(ev.data.args, null, 2) : JSON.stringify(ev.data.args).slice(0, cfg.toolSummaryLen || 120);
  const summary = ev.data.name + '(' + (cfg.toolShowFullArgs ? '' : (argsStr.length < JSON.stringify(ev.data.args).length ? argsStr + '…' : argsStr)) + ')';
  const block = document.createElement('div');
  block.className = 'tool-block running' + (cfg.toolStyle === 'card' ? ' card' : '');
  block.dataset.key = key;
  const head = document.createElement('div'); head.className = 'tool-head';
  head.innerHTML = '<svg class="tool-icon"><use href="#ic-loader"/></svg><span class="tool-name">' + esc(ev.data.name) + '</span><span class="tool-summary">' + esc(summary) + '</span><svg class="tool-chev"><use href="#ic-chev"/></svg>';
  const body = document.createElement('div'); body.className = 'tool-body';
  body.innerHTML = '<div class="tool-section">参数</div><div class="tool-json">' + esc(argsStr) + '</div><div class="tool-section">结果</div><div class="tool-result-pending">等待中…</div>';
  block.appendChild(head); block.appendChild(body);
  head.onclick = () => block.classList.toggle('expanded');
  if (cfg.toolCollapsed === false) block.classList.add('expanded');
  if (group) { group.appendChild(block); currentRoundBlocks.push(key); applyToolGroupFolding(group); } else { messages.appendChild(block); }
  toolBlocks.set(key, { el: block, head, body, argsStr, status: 'running' });
  scrollMessages();
}
function addToolResult(ev) {
  const cfg = (uiState && uiState.chat) || {};
  let target = null, targetKey = null;
  for (const [k, v] of [...toolBlocks].reverse()) { if (k.startsWith(ev.data.name + '#') && v.status === 'running') { target = v; targetKey = k; break; } }
  const resultStr = cfg.toolShowFullArgs ? JSON.stringify(ev.data.result, null, 2) : JSON.stringify(ev.data.result).slice(0, cfg.toolSummaryLen || 120);
  if (!target) { addToolCall({ data: { name: ev.data.name, args: {}, callSeq: Date.now().toString(36) + '-x' } }); const lastKey = [...toolBlocks].pop()[0]; target = toolBlocks.get(lastKey); targetKey = lastKey; }
  const ok = ev.data.result?.ok; target.status = ok ? 'ok' : 'err';
  target.el.classList.remove('running'); target.el.classList.add(ok ? 'ok' : 'err');
  const iconUse = target.head.querySelector('.tool-icon use'); iconUse.setAttribute('href', ok ? '#ic-check' : '#ic-x');
  const pending = target.body.querySelector('.tool-result-pending');
  pending.classList.remove('tool-result-pending'); pending.classList.add(ok ? 'tool-result-ok' : 'tool-result-err');
  pending.textContent = ok ? '成功' : '失败';
  const resultJson = document.createElement('div'); resultJson.className = 'tool-json';
  resultJson.textContent = resultStr + (cfg.toolShowFullArgs ? '' : (JSON.stringify(ev.data.result).length > (cfg.toolSummaryLen||120) ? '…' : ''));
  pending.after(resultJson); scrollMessages();
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function renderMarkdown(text) {
  const BT = String.fromCharCode(96); const fence = BT + BT + BT;
  let html = esc(text);
  const reFence = new RegExp(fence + '(\\\\w*)\\\\n([\\\\s\\\\S]*?)' + fence, 'g');
  html = html.replace(reFence, (_, lang, code) => '<pre><code>' + code.replace(/&quot;/g,'"') + '</code></pre>');
  const reInline = new RegExp(BT + '([^' + BT + '\\\\n]+)' + BT, 'g');
  html = html.replace(reInline, '<code>$1</code>');
  html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  html = html.split(/\\n{2,}/).map(p => '<p>' + p.replace(/\\n/g, '<br>') + '</p>').join('');
  return html;
}
function addMsg(cls, text) {
  const messages = $('cs-messages'); if (!messages) return null;
  const el = document.createElement('div'); el.className = 'msg ' + cls;
  const cfg = (uiState && uiState.chat) || {};
  if (cls === 'assistant' && cfg.markdownEnabled !== false) { el.innerHTML = renderMarkdown(text); } else { el.textContent = text; }
  messages.appendChild(el); scrollMessages(); return el;
}
async function send() {
  const input = $('input'); const btn = $('send-btn');
  const text = input.value.trim(); if (!text || btn.disabled) return;
  btn.disabled = true; input.value = ''; addMsg('user', text);
  const sessionId = await ensureSession(text);
  currentMsgEl = addMsg('assistant', ''); currentStreamId = null; pendingEvents.length = 0;
  const messages = $('cs-messages');
  if (messages) { messages.querySelectorAll('.tool-group').forEach(g => { g.dataset.closed = '1'; }); }
  currentRoundBlocks = [];
  const msg = { type: 'dispatch', reqId: 'req-' + Date.now().toString(36), cap: 'cap.ai.chat', stream: true, params: { messages: [{ role: 'user', content: text }], sessionId } };
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); else pendingDispatch.push(msg);
}

// ================================================================================
// 设置覆盖层 (tab 系统)
// ================================================================================
const settingsTabs = [
  { id: 'general', label: '通用', render: renderGeneralSettings },
  { id: 'ai', label: 'AI 配置', render: renderAiSettings },
  { id: 'workspace', label: '工作区', render: renderWorkspaceSettings },
  { id: 'theme', label: '主题', render: renderThemeSettings },
  { id: 'security', label: '安全', render: renderSecuritySettings },
  { id: 'storage', label: '数据存储', render: renderStorageSettings },
  { id: 'about', label: '关于', render: renderAboutSettings },
];
function openSettings(tab) {
  state.settingsOpen = true; state.settingsTab = tab || 'general';
  $('settings-overlay').classList.add('open'); renderSettings();
}
function closeSettings() { state.settingsOpen = false; $('settings-overlay').classList.remove('open'); }
function renderSettings() {
  const tabs = $('settings-tabs'); if (!tabs) return;
  tabs.innerHTML = settingsTabs.map(t => '<button class="s-tab' + (state.settingsTab === t.id ? ' active' : '') + '" data-tab="' + t.id + '">' + t.label + '</button>').join('');
  tabs.querySelectorAll('.s-tab').forEach(btn => { btn.onclick = () => { state.settingsTab = btn.dataset.tab; renderSettings(); }; });
  const content = $('settings-content');
  const tab = settingsTabs.find(t => t.id === state.settingsTab);
  if (tab && tab.render) tab.render(content);
}
function renderGeneralSettings(el) {
  el.innerHTML = '<h2>通用</h2>' +
    '<div class="field"><label>数据根目录</label><input type="text" id="cfg-data-root" readonly></div>' +
    '<div class="field"><label>当前会话</label><input type="text" id="cfg-session-id" readonly></div>' +
    '<div class="status" id="general-status"></div>';
  dispatch('cap.config', { action: 'get' }).then(cfg => {
    // 临时占位: 实际数据根从 cap.shell.info 或 cap.storage 获取
  });
  const sid = curSessionId();
  const sidEl = $('cfg-session-id'); if (sidEl) sidEl.value = sid || '(无)';
}
function renderAiSettings(el) {
  el.innerHTML = '<h2>AI 配置</h2>' +
    '<div class="field"><label>Base URL</label><input id="base-url" type="text" placeholder="https://api.openai.com"></div>' +
    '<div class="field"><label>API Key</label><input id="api-key" type="password" placeholder="sk-..."></div>' +
    '<div class="field"><label>Model</label><input id="model" type="text" placeholder="gpt-4o-mini"></div>' +
    '<button class="btn" id="save-config">保存配置</button><div class="status" id="config-status"></div>';
  fetch('/api/config').then(r=>r.json()).then(r => {
    const cfg = r.result?.ok ? r.result.data : {};
    const baseEl = $('base-url'); if (baseEl) baseEl.value = cfg.ai?.baseUrl || '';
    const keyEl = $('api-key'); if (keyEl) keyEl.value = cfg.ai?.apiKey || '';
    const modelEl = $('model'); if (modelEl) modelEl.value = cfg.ai?.model || 'gpt-4o-mini';
  });
  $('save-config').onclick = async () => {
    const status = $('config-status'); status.textContent = '保存中...'; status.className = 'status';
    const r = await fetch('/api/config', { method:'POST', headers: JSON_HEADERS, body: JSON.stringify({ ai: {
      baseUrl: $('base-url').value, apiKey: $('api-key').value, model: $('model').value || 'gpt-4o-mini',
    }})}).then(r=>r.json());
    if (r.result?.ok) { status.textContent = '已保存'; status.className = 'status ok'; }
    else { status.textContent = '失败: ' + (r.result?.error || '未知错误'); status.className = 'status err'; }
  };
}
function renderThemeSettings(el) {
  const presets = ['dark', 'midnight', 'ocean', 'forest', 'sunset'];
  el.innerHTML = '<h2>主题</h2><div id="theme-presets" style="display:flex;gap:8px;flex-wrap:wrap"></div>' +
    '<div class="status" id="theme-status" style="margin-top:12px"></div>';
  const host = $('theme-presets');
  host.innerHTML = presets.map(p => '<button class="btn secondary" data-theme="' + p + '" style="width:auto">' + p + '</button>').join('');
  host.querySelectorAll('[data-theme]').forEach(btn => {
    btn.onclick = async () => {
      await dispatch('cap.ui.theme', { action: 'apply', preset: btn.dataset.theme });
      const s = $('theme-status'); s.textContent = '已切换: ' + btn.dataset.theme; s.className = 'status ok';
    };
  });
}
function renderWorkspaceSettings(el) {
  el.innerHTML = '<h2>工作区</h2>' +
    '<div id="ws-settings-list" style="margin-bottom:16px"><div style="color:var(--sky-text-muted,#8b949e);font-size:12px;padding:8px 0">加载中...</div></div>' +
    '<h2 style="margin-top:16px">添加工作区</h2>' +
    '<div class="field"><label>根目录路径 (绝对路径)</label><input id="ws-add-path" type="text" placeholder="D:\\\\proj\\\\my-app 或 /home/user/proj"></div>' +
    '<div class="field"><label>名称 (可选)</label><input id="ws-add-name" type="text" placeholder="留空则用目录名"></div>' +
    '<button class="btn" id="ws-add-btn">添加工作区</button>' +
    '<div class="status" id="ws-status"></div>';
  $('ws-add-btn').onclick = async () => {
    const root = $('ws-add-path').value.trim();
    if (!root) { $('ws-status').textContent = '请输入路径'; $('ws-status').className = 'status err'; return; }
    const name = $('ws-add-name').value.trim() || undefined;
    const data = await dispatch('cap.workspace', { action: 'set', root, name });
    const s = $('ws-status');
    if (data && data.ok !== false) { s.textContent = '已添加: ' + (data.name || root); s.className = 'status ok'; $('ws-add-path').value = ''; $('ws-add-name').value = ''; refreshWorkspace(); renderWorkspaceSettings(el); }
    else { s.textContent = '失败: ' + (data ? data.error : '未知错误'); s.className = 'status err'; }
  };
  dispatch('cap.workspace', { action: 'list' }).then(data => {
    const list = $('ws-settings-list');
    const workspaces = (data && data.workspaces) || [];
    const currentId = (data && data.currentId) || (currentWorkspace ? currentWorkspace.id : null);
    if (!workspaces.length) { list.innerHTML = '<div style="color:var(--sky-text-muted,#8b949e);font-size:12px;padding:8px 0">暂无工作区</div>'; return; }
    list.innerHTML = workspaces.map(w => {
      const isCurrent = w.id === currentId;
      return '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--sky-bg-elevated,#161b22);border:1px solid var(--sky-border,#21262d);border-radius:6px;margin-bottom:8px">' +
        '<div style="flex:1;overflow:hidden"><div style="font-size:13px;color:var(--sky-text,#c9d1d9)">' + esc(w.name) + (isCurrent ? ' <span style="color:var(--sky-accent,#58a6ff);font-size:10px">(当前)</span>' : '') + '</div>' +
        '<div style="font-size:11px;color:var(--sky-text-muted,#8b949e);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(w.root) + '</div></div>' +
        (isCurrent ? '' : '<button class="btn secondary" style="width:auto;padding:6px 10px;min-height:32px;font-size:12px" data-wswitch="' + esc(w.id) + '">切换</button>') +
        '<button class="btn secondary" style="width:auto;padding:6px 10px;min-height:32px;font-size:12px" data-wdelete="' + esc(w.id) + '">删除</button></div>';
    }).join('');
    list.querySelectorAll('[data-wswitch]').forEach(b => b.onclick = async () => { await switchWorkspace(b.dataset.wswitch); renderWorkspaceSettings(el); });
    list.querySelectorAll('[data-wdelete]').forEach(b => b.onclick = async () => { await deleteWorkspace(b.dataset.wdelete); renderWorkspaceSettings(el); });
  });
}

function renderSecuritySettings(el) {
  const info = authInfo || {};
  const authRequired = info.authRequired === true;
  el.innerHTML = '<h2>安全</h2>' +
    '<div id="sec-status" style="margin-bottom:16px"></div>' +
    '<h2 style="margin-top:8px">签发 Token</h2>' +
    '<div class="field"><label>名称 (用途标记, 必填)</label><input id="tok-name" type="text" placeholder="例如: 手机浏览器 / CI 脚本"></div>' +
    '<div class="field"><label>角色</label><select id="tok-role" style="width:100%;padding:8px 10px;background:var(--sky-bg,#0d1117);color:var(--sky-text,#c9d1d9);border:1px solid var(--sky-border,#21262d);border-radius:6px">' +
    '<option value="user">user (仅调用能力)</option><option value="admin">admin (可管理 token)</option></select></div>' +
    '<div class="field"><label>有效期 (天, 留空=永不过期)</label><input id="tok-exp" type="number" min="1" placeholder="30"></div>' +
    '<button class="btn" id="tok-issue-btn">签发</button>' +
    '<div id="tok-raw-box"></div>' +
    '<h2 style="margin-top:20px">已签发 Token</h2>' +
    '<div id="tok-list"><div style="color:var(--sky-text-muted,#8b949e);font-size:12px">加载中...</div></div>' +
    '<div class="status" id="sec-status-msg"></div>';

  // 状态区
  const st = $('sec-status');
  const stateHtml = (ok, text) => '<span class="tok-state ' + (ok ? 'ok' : 'bad') + '">' + text + '</span>';
  st.innerHTML = '<div class="tok-item"><div class="tok-info">' +
    '<div class="tok-name">强制认证: ' + stateHtml(authRequired, authRequired ? '已开启' : '未开启 (本地开发)') + '</div>' +
    '<div class="tok-meta">当前身份: ' + (info.authed ? esc(info.authName || '已认证') + (info.admin ? ' (admin)' : ' (user)') : '未认证') +
    (storedToken() ? ' · 本地已存 token' : ' · 本地未存 token') + '</div>' +
    '</div></div>' +
    '<div style="font-size:12px;color:var(--sky-text-muted,#8b949e);line-height:1.7">开启强制认证: 在配置中设 server.authRequired=true (并建议设置 server.token 作管理员主 token). 开启后所有 /api 请求需带 Authorization: Bearer sk-...</div>';

  // 签发
  $('tok-issue-btn').onclick = async () => {
    const name = $('tok-name').value.trim();
    if (!name) { flashStatus('请填写 token 名称', 'err'); return; }
    const role = $('tok-role').value;
    const expDays = parseInt($('tok-exp').value, 10);
    const params = { action: 'issue', name, role };
    if (expDays > 0) params.expiresDays = expDays;
    const data = await dispatch('cap.auth', params);
    if (data && data.ok) {
      $('tok-raw-box').innerHTML = '<div class="tok-raw"><strong style="color:var(--sky-accent,#58a6ff)">token 原文 (仅显示这一次, 请立即保存):</strong><br>' + esc(data.token) + '</div>';
      $('tok-name').value = ''; $('tok-exp').value = '';
      renderTokenList();
    } else {
      $('tok-raw-box').innerHTML = '';
      flashStatus('签发失败: ' + (data && data.error || '需要 admin 权限'), 'err');
    }
  };

  function flashStatus(text, cls) {
    const s = $('sec-status-msg'); if (!s) return;
    s.textContent = text; s.className = 'status ' + (cls || '');
    setTimeout(() => { if (s.textContent === text) { s.textContent = ''; s.className = 'status'; } }, 4000);
  }

  async function renderTokenList() {
    const data = await dispatch('cap.auth', { action: 'list' });
    const list = $('tok-list');
    if (!list) return;
    if (!data || data.ok === false) {
      list.innerHTML = '<div style="color:var(--sky-text-muted,#8b949e);font-size:12px">读取失败 (需要 admin 权限)</div>';
      return;
    }
    const tokens = data.tokens || [];
    if (!tokens.length) { list.innerHTML = '<div style="color:var(--sky-text-muted,#8b949e);font-size:12px">暂无 token</div>'; return; }
    const fmt = (ts) => ts ? new Date(ts).toLocaleString('zh-CN') : '-';
    list.innerHTML = tokens.map(t => {
      const active = !t.revoked && !t.expired;
      return '<div class="tok-item"><div class="tok-info">' +
        '<div class="tok-name">' + esc(t.name) + ' <span class="tok-state ' + (active ? 'ok' : 'bad') + '">' + (t.revoked ? '已吊销' : (t.expired ? '已过期' : t.role)) + '</span></div>' +
        '<div class="tok-meta">' + esc(t.prefix) + '... · 创建 ' + fmt(t.createdAt) + ' · 最近使用 ' + fmt(t.lastUsedAt) + (t.expiresAt ? ' · 过期 ' + fmt(t.expiresAt) : ' · 永不过期') + '</div>' +
        '</div>' + (active ? '<button class="btn secondary" style="width:auto;padding:6px 10px;min-height:32px;font-size:12px" data-tok-revoke="' + esc(t.id) + '">吊销</button>' : '') +
        '</div>';
    }).join('');
    list.querySelectorAll('[data-tok-revoke]').forEach(b => {
      b.onclick = async () => {
        if (!window.confirm('确定吊销该 token? 使用它的客户端将立即失去访问权.')) return;
        await dispatch('cap.auth', { action: 'revoke', id: b.dataset.tokRevoke });
        renderTokenList();
      };
    });
  }
  renderTokenList();
}

function renderStorageSettings(el) {
  el.innerHTML = '<h2>数据存储</h2>' +
    '<div id="storage-info" style="margin-bottom:12px"><div style="color:var(--sky-text-muted,#8b949e);font-size:12px">加载中...</div></div>' +
    '<h2 style="margin-top:16px">维护</h2>' +
    '<button class="btn secondary" id="storage-vacuum" style="width:auto">清理碎片 (VACUUM)</button>' +
    '<div class="status" id="storage-status"></div>';
  dispatch('cap.storage', { action: 'info' }).then(data => {
    const info = $('storage-info');
    if (!data || data.ok === false) { info.innerHTML = '<div style="color:var(--sky-text-muted,#8b949e);font-size:12px">读取失败</div>'; return; }
    const fmtSize = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB';
    const tables = data.tables || {};
    const names = Object.keys(tables);
    const tableRows = names.map(n =>
      '<div style="display:flex;justify-content:space-between;padding:2px 0">' +
      '<span style="color:var(--sky-text,#c9d1d9)">' + esc(n) + '</span>' +
      '<span style="color:var(--sky-text-muted,#8b949e)">' + tables[n] + ' 行</span></div>'
    ).join('');
    info.innerHTML = '<div style="font-size:13px;line-height:1.8;color:var(--sky-text,#c9d1d9)">' +
      '<p><strong style="color:var(--sky-text-muted,#8b949e);font-size:11px">后端</strong><br>' + esc(data.backend || '未知') + '</p>' +
      '<p><strong style="color:var(--sky-text-muted,#8b949e);font-size:11px">数据库路径</strong><br><span style="word-break:break-all">' + esc(data.path || '未知') + '</span></p>' +
      '<p><strong style="color:var(--sky-text-muted,#8b949e);font-size:11px">数据库大小</strong><br>' + (data.size != null ? fmtSize(data.size) : '未知') + '</p>' +
      '<p style="margin-bottom:4px"><strong style="color:var(--sky-text-muted,#8b949e);font-size:11px">表 (' + names.length + ')</strong></p>' +
      (names.length ? tableRows : '<div style="color:var(--sky-text-muted,#8b949e);font-size:12px">无表</div>') +
      '</div>';
  });
  $('storage-vacuum').onclick = async () => {
    const s = $('storage-status'); s.textContent = '清理中...'; s.className = 'status';
    const data = await dispatch('cap.storage', { action: 'vacuum' });
    if (data && data.ok !== false) { s.textContent = '清理完成'; s.className = 'status ok'; }
    else { s.textContent = '失败: ' + (data ? data.error : '未知'); s.className = 'status err'; }
  };
}

function renderAboutSettings(el) {
  el.innerHTML = '<h2>关于</h2><div style="font-size:13px;line-height:1.8;color:var(--sky-text-muted,#8b949e)">' +
    '<p><strong style="color:var(--sky-text,#c9d1d9)">Sky</strong> · Capability OS</p>' +
    '<p>Node + TypeScript 无头 Core + Web Shell</p>' +
    '<p>一切能力通过 cap 注册, AI 可调用所有 cap 含 UI 演进</p>' +
    '<p style="margin-top:12px">架构: 对齐 Polaris 布局范式</p>' +
    '<p>断点: 500px (compact 模式)</p>' +
    '<p>保活: hidden 属性 (DOM 保留, 状态不丢)</p>' +
    '</div>';
}

// ================================================================================
// UI State 渲染 (theme + styles + chat config + 动态组件)
// ================================================================================
function render() {
  if (!uiState) return;
  const t = uiState.theme || {};
  let css = ':root{';
  for (const [k,v] of Object.entries(t.colors||{})) css += '--sky-' + kebab(k) + ':' + v + ';';
  for (const [k,v] of Object.entries(t.spacing||{})) css += '--sky-' + kebab(k) + ':' + v + ';';
  for (const [k,v] of Object.entries(t.typography||{})) css += '--sky-' + kebab(k) + ':' + v + ';';
  for (const [k,v] of Object.entries(t.shadows||{})) css += '--sky-' + kebab(k) + ':' + v + ';';
  for (const [k,v] of Object.entries(t.radii||{})) css += '--sky-' + kebab(k) + ':' + v + ';';
  css += '}';
  for (const rule of (uiState.styles||[])) { css += rule.selector + '{' + Object.entries(rule.properties||{}).map(([k,v])=>kebab(k)+':'+v).join(';') + '}'; }
  dynamicStyle.textContent = css;
  const c = uiState.chat || {};
  const root = document.documentElement.style;
  root.setProperty('--msg-user-maxw', c.userMaxWidth || '85%');
  root.setProperty('--msg-assistant-maxw', c.assistantMaxWidth || '100%');
  root.setProperty('--chat-gap', c.messageGap || '10px');
  root.setProperty('--chat-fontsize', (c.fontSize || 15) + 'px');
  renderComponents(); uiUpdateNotify();
}
function kebab(s) { return s.replace(/([A-Z])/g, '-$1').toLowerCase(); }

// ================================================================================
// 动态组件渲染 (AI 注入, 真脚本执行)
// ================================================================================
const MOUNT_MAP = { sessions: 'lp-sessions', files: 'lp-files', caps: 'lp-caps', main: 'cs-messages', right: 'right-panel', sidebar: 'lp-sessions' };
const liveComponents = new Map();
const customListeners = new Set();
const SKY_HOST = {
  dispatch: dispatch,
  state: function () { return uiState ? structuredClone(uiState) : null; },
  on: function (fn) { if (typeof fn === 'function') customListeners.add(fn); return function off() { customListeners.delete(fn); }; },
  page: function () { return state.activeLeftPanel; },
  switchPage: (id) => toggleLeftPanel(id),
  addMsg: addMsg,
};
window.__sky = SKY_HOST;
function uiUpdateNotify() { for (const fn of customListeners) { try { fn(uiState); } catch (e) { console.warn('[custom] listener', e); } } }
function compSig(comp) { try { return JSON.stringify(comp.props || {}) + '@' + (comp.mountPoint || ''); } catch (e) { return Math.random().toString(36); } }
function execCustomJs(code, root) {
  try { const factory = new Function('root', '__sky', code); factory(root, SKY_HOST); return null; }
  catch (e) { return e; }
}
function renderComponents() {
  if (!uiState || !uiState.components) return;
  const seen = new Set();
  for (const comp of uiState.components) {
    if (comp.type !== 'custom') continue; seen.add(comp.id);
    const hostId = MOUNT_MAP[comp.mountPoint] || MOUNT_MAP.right; const host = $(hostId); if (!host) continue;
    const sig = compSig(comp); const prev = liveComponents.get(comp.id);
    if (prev && prev.sig === sig) continue;
    let zone = $('sky-custom-zone-' + hostId);
    if (!zone) { zone = document.createElement('div'); zone.id = 'sky-custom-zone-' + hostId; zone.className = 'sky-custom-zone'; host.appendChild(zone); }
    if (prev) { if (prev.root && prev.root.parentNode) prev.root.parentNode.removeChild(prev.root); if (prev.styleEl && prev.styleEl.parentNode) prev.styleEl.parentNode.removeChild(prev.styleEl); }
    const props = comp.props || {}; const wrapper = document.createElement('div');
    wrapper.className = 'sky-custom-comp'; wrapper.dataset.compId = comp.id;
    if (props.html) wrapper.innerHTML = props.html; zone.appendChild(wrapper);
    let styleEl = null;
    if (props.css) { styleEl = document.createElement('style'); styleEl.textContent = scopeCss(props.css, wrapper); document.head.appendChild(styleEl); }
    liveComponents.set(comp.id, { sig, root: wrapper, styleEl });
    if (typeof props.js === 'string' && props.js.trim()) {
      const err = execCustomJs(props.js, wrapper);
      if (err) { console.warn('[custom] js error in ' + comp.id + ':', err.message); const note = document.createElement('div'); note.style.cssText = 'margin-top:8px;padding:6px 8px;font-size:11px;border-radius:4px;background:rgba(248,81,73,.12);color:#f85149;'; note.textContent = '组件脚本错误: ' + err.message; wrapper.appendChild(note); }
    }
  }
  for (const [id, prev] of liveComponents) { if (seen.has(id)) continue; if (prev.root && prev.root.parentNode) prev.root.parentNode.removeChild(prev.root); if (prev.styleEl && prev.styleEl.parentNode) prev.styleEl.parentNode.removeChild(prev.styleEl); liveComponents.delete(id); }
  for (const z of document.querySelectorAll('.sky-custom-zone')) { if (!z.childElementCount) z.parentNode.removeChild(z); }
}
function scopeCss(css, wrapper) {
  const id = 'sky-c-' + Math.random().toString(36).slice(2, 9);
  wrapper.id = wrapper.id ? wrapper.id + ' ' + id : id;
  const PREFIX = '#' + id + ' '; let depth = 0; let kfDepth = -1;
  return css.replace(/\\s*([^{}]*)\\{|\\}/g, function (m) {
    if (m === '}') { if (depth === kfDepth) kfDepth = -1; depth--; return '}'; }
    const sel = m.replace(/\\{$/, '').trim();
    if (/^@/.test(sel)) { if (/^@keyframes/i.test(sel)) kfDepth = depth + 1; depth++; return m; }
    const inKeyframes = depth === kfDepth; depth++;
    if (inKeyframes) return m;
    return ' ' + sel.split(',').map(function (s) { const t = s.trim(); return t ? PREFIX + t : t; }).join(',') + '{';
  });
}

// ================================================================================
// WS 连接
// ================================================================================
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = storedToken() || new URLSearchParams(location.search).get('token') || '';
  const url = proto + '://' + location.host + '/ws' + (token ? '?token=' + encodeURIComponent(token) : '');
  ws = new WebSocket(url);
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'shell-register', caps: ['cap.ui.observe'] }));
    while (pendingDispatch.length) ws.send(JSON.stringify(pendingDispatch.shift()));
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'event') handleEvent(msg.event);
    else if (msg.type === 'shell-invoke') handleShellInvoke(msg);
    else if (msg.type === 'reply') {
      const data = msg.reply?.result?.ok ? msg.reply.result.data : null;
      if (data && data.streamId) { currentStreamId = data.streamId; while (pendingEvents.length) handleEvent(pendingEvents.shift()); }
      else if (!msg.reply?.result?.ok) { if (currentMsgEl && !currentMsgEl.textContent) { currentMsgEl.textContent = '错误: ' + (msg.reply?.result?.error || 'unknown'); } const btn = $('send-btn'); if (btn) btn.disabled = false; }
    }
  };
  ws.onclose = () => setTimeout(connectWs, 1000);
}
async function handleShellInvoke(msg) {
  const p = msg.params || {}; const action = p.action;
  if (action === 'screenshot' || action === 'inspect' || action === 'metrics') {
    const r = await observeInvoke(p); ws.send(JSON.stringify({ type: 'shell-invoke-result', reqId: msg.reqId, result: r }));
  } else { ws.send(JSON.stringify({ type: 'shell-invoke-result', reqId: msg.reqId, result: { ok: false, error: 'unknown action: ' + action } })); }
}
async function observeInvoke(p) {
  const action = p.action;
  if (action === 'screenshot') {
    if (!('captureScreen' in window)) return { ok: false, error: 'screenshot not supported' };
    return { ok: true, note: 'use browser devtools' };
  }
  if (action === 'inspect') {
    const sel = p.selector; if (!sel) return { ok: false, error: 'selector required' };
    const el = document.querySelector(sel); if (!el) return { ok: false, notFound: true };
    const r = el.getBoundingClientRect();
    return { ok: true, tag: el.tagName, id: el.id, className: el.className, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, text: (el.innerText || '').slice(0, 500) };
  }
  if (action === 'metrics') {
    const entries = performance.getEntriesByType('navigation');
    const nav = entries[0] || {};
    return { ok: true, dom: document.documentElement.outerHTML.length, title: document.title, scrollY: window.scrollY, nav: { loadTime: nav.loadEventEnd, domContentLoaded: nav.domContentLoadedEventEnd } };
  }
  return { ok: false, error: 'unknown observe action: ' + action };
}

// ================================================================================
// 事件处理
// ================================================================================
function handleEvent(ev) {
  if (ev.type === 'ui.update') { uiState = ev.data; render(); return; }
  if (ev.type === 'shell.notify') { addMsg('assistant', '[通知] ' + (ev.data?.message||'')); return; }
  if (ev.type === 'shell.reload') { location.reload(); return; }
  if (ev.stream_id !== currentStreamId) { if (currentStreamId === null && ev.type.startsWith('stream.')) pendingEvents.push(ev); return; }
  switch (ev.type) {
    case 'stream.chunk':
      if (currentMsgEl) {
        const cfg = (uiState && uiState.chat) || {};
        if (cfg.markdownEnabled !== false) { currentMsgEl._raw = (currentMsgEl._raw || '') + ev.data; currentMsgEl.innerHTML = renderMarkdown(currentMsgEl._raw); }
        else { currentMsgEl.textContent += ev.data; }
        scrollMessages();
      } break;
    case 'stream.tool': addToolCall(ev); break;
    case 'stream.toolResult': addToolResult(ev); break;
    case 'stream.end':
      currentStreamId = null; const btn = $('send-btn'); if (btn) btn.disabled = false; collapseCurrentRound(); break;
  }
}
function collapseCurrentRound() {
  const cfg = (uiState && uiState.chat) || {}; if (cfg.autoCollapseOnEnd === false) return;
  currentRoundBlocks.forEach(key => { const entry = toolBlocks.get(key); if (entry) { entry.el.classList.remove('expanded'); entry.el.classList.add('folded'); } });
  const messages = $('cs-messages'); if (messages) { const group = messages.querySelector('.tool-group:last-child'); if (group) group.dataset.closed = '1'; }
}

// ================================================================================
// 键盘适配 (visualViewport)
// ================================================================================
const vv = window.visualViewport;
if (vv) {
  vv.addEventListener('resize', () => { const m = $('sky-main'); if (m) m.style.height = vv.height + 'px'; scrollMessages(); });
  vv.addEventListener('scroll', scrollMessages);
}

// ================================================================================
// 响应式断点 (500px, 对齐原 Polaris)
// ================================================================================
function updateCompact() {
  const wasCompact = state.isCompact;
  state.isCompact = window.innerWidth < 500;
  if (wasCompact !== state.isCompact) applyLeftPanel();
}
window.matchMedia('(max-width: 500px)').addEventListener('change', updateCompact);
window.addEventListener('resize', updateCompact);

// ================================================================================
// 启动
// ================================================================================
// 认证先行: 校验本地 token, 强制认证未通过则弹登录层 (后续 API 会 401, 但页面骨架照常)
setupLogin();
verifyAuthToken().then(info => {
  if (info && info.authRequired && !info.authed) showLogin();
  const b = $('cap-badge');
  if (b && info && info.authRequired) b.title = info.authed ? ('已认证: ' + (info.authName || '')) : '未认证';
});
connectWs();
renderActivityBar();
renderSessionList();
renderFileList();
renderCapsList();
refreshWorkspace();
const sendBtn = $('send-btn'); sendBtn.onclick = send;
const input = $('input');
input.onkeydown = (e) => { if (e.key === 'Enter' && !sendBtn.disabled) send(); };
input.addEventListener('focus', () => setTimeout(scrollMessages, 300));
$('ct-new').onclick = newSession;
$('tb-settings').onclick = () => openSettings('general');
$('tb-workspace').onclick = toggleWorkspaceDropdown;
$('tb-menu').onclick = () => toggleLeftPanel(state.activeLeftPanel === 'sessions' ? 'files' : 'sessions');
$('s-close').onclick = closeSettings;
// 点击外部关闭工作区下拉
document.addEventListener('click', (e) => {
  const dd = $('ws-dropdown');
  const btn = $('tb-workspace');
  if (dd.classList.contains('open') && !dd.contains(e.target) && !btn.contains(e.target)) {
    dd.classList.remove('open');
  }
});
fetch('/api/ui-state').then(r=>r.json()).then(r => { if (r && r.theme) { uiState = r; render(); } }).catch(()=>{});
dispatch('cap.session', { action: 'getCurrent' }).then(data => {
  const id = data && data.currentId; if (!id) return; setSessionId(id);
  if ($('cs-messages')?.children.length > 1) return; loadSessionIntoChat(id, true);
}).catch(()=>{});
dispatch('cap.shell', { action: 'info' }).then(info => {
  if (info && info.caps !== undefined) { const b = $('cap-badge'); if (b) b.textContent = info.caps + ' caps'; }
}).catch(()=>{});
</script>
</body>
</html>`;

