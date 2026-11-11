/* eslint-disable @typescript-eslint/no-require-imports, no-console -- 独立 node 脚本（CommonJS require + 控制台输出是脚本本性），非 src 源码；spec §11/补充约束 17 以 node plans/git-plugin-ui-prototype-check.js 运行 */
/**
 * Git 插件 UI 交互原型 —— 可复跑的回归检查（44 项断言）
 *
 * 用途：确认原型的关键交互与视觉约束未被改坏；也可作为 GLM 实施阶段的
 *       交互验收参照。仅验证「模拟数据下的渲染与交互」，不证明 cap.git、
 *       AI 会话、编辑器扩展、桌面/Web 或热更新可行（见实施规范 §11）。
 *
 * 运行：node plans/git-plugin-ui-prototype-check.js
 * 依赖：playwright（本机无浏览器时自动回退到 playwright 自带 chromium）
 * 说明：路径基于 __dirname 自适应，不依赖固定盘符；无外部网络请求。
 */
const { chromium } = require('playwright');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PROTOTYPE = path.join(__dirname, 'git-plugin-ui-interaction-prototype.html');
const URL = 'file:///' + PROTOTYPE.replace(/\\/g, '/');
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
];

const passed = [];
const ok = (name, cond, detail) => {
  assert.ok(cond, 'FAIL ' + name + (detail ? ' | ' + detail : ''));
  passed.push('PASS  ' + name + (detail ? ' | ' + detail : ''));
};

(async () => {
  assert.ok(fs.existsSync(PROTOTYPE), '找不到原型文件：' + PROTOTYPE);
  const executablePath = BROWSERS.find(p => fs.existsSync(p));
  const browser = await chromium.launch(executablePath ? { headless: true, executablePath } : { headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(URL);
  await page.waitForSelector('#git-panel .file-row');

  const count = sel => page.locator(sel).count();
  const panelOverflow = () => page.locator('#git-panel').evaluate(e => ({ cw: e.clientWidth, sw: e.scrollWidth }));

  // 1. 初始渲染与信息架构
  ok('初始渲染 6 条变更', (await count('.file-row')) === 6);
  ok('7 个功能 Tab', (await count('[data-action="tab"]')) === 7);
  ok('提交区存在且默认禁用', await page.locator('#commit-button').isDisabled());
  ok('原型标注模拟数据', (await page.locator('.prototype-badge').innerText()).includes('模拟数据'));

  // 2. 三档宽度：无横向溢出（规范 §3.2 / 验收 §13.1）
  for (const w of [240, 360, 560]) {
    await page.locator('[data-action="width"][data-value="' + w + '"]').click();
    await page.waitForTimeout(120);
    const { cw, sw } = await panelOverflow();
    ok('宽度 ' + w + 'px 面板无横向溢出', Math.abs(cw - w) <= 2 && sw <= cw + 1,
      'client=' + cw + ' scroll=' + sw + '（边框/flex 压缩容差 2px）');
  }
  const bodyOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('页面无整体横向溢出', bodyOverflow <= 0, 'overflow=' + bodyOverflow);

  // 3. 窄栏 diff 自动溢出到中央；宽栏留在面板
  await page.locator('[data-action="width"][data-value="240"]').click();
  await page.locator('[data-action="open-diff"]').first().click();
  ok('240px：diff 走中央 Tab', (await count('#center-stage .diff-code')) === 1 && (await count('#git-panel .diff-head')) === 0);
  await page.locator('[data-action="width"][data-value="360"]').click();
  await page.locator('[data-action="open-diff"]').first().click();
  ok('360px：diff 留在面板内', (await count('#git-panel .diff-head')) === 1 && (await count('#git-panel .diff-code')) === 1);
  await page.locator('[data-action="central-current"]').click();
  ok('「在中央打开」切中央 Diff Tab', (await page.locator('.center-tab').innerText()).includes('Diff'));
  await page.locator('[data-action="width"][data-value="360"]').click();
  await page.locator('[data-action="open-diff"]').first().click();
  await page.locator('[data-action="close-diff"]').click();
  ok('返回变更列表', (await count('#git-panel .file-row')) === 6);

  // 4. AI 独立 kind 会话 → 建议回流 → 人工提交（规范 GP-05）
  await page.locator('[data-action="ai-generate"]').first().click();
  ok('AI 打开中央独立会话', (await count('.chat-view')) === 1 && (await page.locator('.chat-context-title').innerText()).includes('独立 kind 会话'));
  await page.waitForTimeout(1050);
  ok('AI 建议卡出现在侧栏', (await count('.ai-suggestion')) === 1);
  await page.locator('.chat-view [data-action="ai-adopt"]').click();
  ok('采用后写入提交框但未自动提交', (await page.locator('#commit-message').inputValue()).startsWith('feat:'));
  ok('提交按钮已可用', !(await page.locator('#commit-button').isDisabled()));
  await page.locator('#commit-button').click();
  await page.waitForTimeout(800);
  ok('提交后清空草稿', (await page.locator('#commit-message').inputValue()) === '');

  // 5. 冲突 → 三方合并 → 标记解决（规范 GP-09 / §5.4 派生标志）
  await page.locator('#scenario').selectOption('conflict');
  ok('冲突横幅出现', (await count('.conflict-banner')) === 1);
  await page.locator('[data-action="open-merge"]').click();
  ok('中央三方合并器', (await count('.merge-grid')) === 1 && (await count('.merge-pane')) === 3);
  ok('未选择时「标记已解决」禁用', await page.locator('[data-action="merge-resolve"]').isDisabled());
  await page.locator('[data-action="merge-choice"][data-value="incoming"]').first().click();
  ok('选择后解锁解决', !(await page.locator('[data-action="merge-resolve"]').isDisabled()));
  await page.locator('[data-action="merge-resolve"]').click();
  ok('解决后冲突横幅消失（横幅由真实冲突列表驱动）', (await count('.conflict-banner')) === 0);

  // 6. 危险操作：影响说明 + 快照 + 确认 + Undo（规范 GP-10）
  await page.locator('#scenario').selectOption('normal');
  await page.locator('[data-action="discard"]').first().click();
  ok('危险操作确认框', (await count('[role="dialog"]')) === 1);
  const dialogText = await page.locator('[role="dialog"]').innerText();
  ok('确认框含影响范围与快照说明', dialogText.includes('影响范围') && dialogText.includes('快照') && dialogText.includes('丢弃'));
  await page.locator('[data-action="dialog-cancel"]').click();
  ok('取消后关闭确认框', (await count('[role="dialog"]')) === 0);
  await page.locator('[data-action="discard"]').first().click();
  await page.locator('[data-action="dialog-confirm"]').click();
  ok('确认后提供撤销入口', (await count('[data-action="undo-discard"]')) === 1);
  await page.locator('[data-action="undo-discard"]').click();
  ok('撤销后文件恢复', (await count('#git-panel .file-row')) === 6);

  // 7. 主题、5 种场景、7 个 Tab 全量切换无渲染异常
  await page.locator('[data-action="theme"]').click();
  ok('主题切到浅色', (await page.locator('html').getAttribute('data-theme')) === 'light');
  await page.locator('[data-action="theme"]').click();
  ok('主题切回深色', (await page.locator('html').getAttribute('data-theme')) === 'dark');
  for (const s of ['loading', 'error', 'empty', 'normal']) {
    await page.locator('#scenario').selectOption(s);
    ok('场景 ' + s + ' 正常渲染', (await count('#git-panel')) === 1);
  }
  const tabs = await page.locator('[data-action="tab"]').evaluateAll(els => els.map(e => e.dataset.value));
  for (const t of tabs) {
    await page.locator('[data-action="tab"][data-value="' + t + '"]').click();
    ok('Tab ' + t + ' 切换正常', (await count('#git-panel')) === 1);
  }
  await page.locator('[data-action="tab"][data-value="changes"]').click();

  // 8. 键盘：Ctrl+Enter 提交、Escape 关闭面板 diff
  await page.locator('#commit-message').fill('chore: 键盘提交验证');
  await page.locator('#commit-message').press('Control+Enter');
  await page.waitForTimeout(800);
  ok('Ctrl+Enter 提交清空草稿', (await page.locator('#commit-message').inputValue()) === '');
  await page.locator('[data-action="open-diff"]').first().click();
  ok('打开面板内 diff', (await count('#git-panel .diff-head')) === 1);
  await page.keyboard.press('Escape');
  ok('Escape 退出面板 diff', (await count('#git-panel .diff-head')) === 0 && (await count('#git-panel .file-row')) > 0);

  ok('全程无脚本异常', errors.length === 0, JSON.stringify(errors));

  await browser.close();
  console.log(passed.join('\n'));
  console.log('\n=== ' + passed.length + ' 项断言全部通过 ===');
})().catch(e => { console.error(e.stack || e); process.exit(1); });
