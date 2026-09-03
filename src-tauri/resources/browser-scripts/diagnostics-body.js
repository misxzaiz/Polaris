/**
 * 诊断快照 body：依赖 collector（clean / collectPolarisInteractiveElements / toPolarisVisualElement）
 * 与 __POLARIS_BROWSER_CONSOLE__（console-capture.js 建立）。
 * 此文件是 body（不含 IIFE），由 diagnostics_script() 组合包裹执行。
 */
const elements = collectPolarisInteractiveElements({ viewportOnly: true, maxElements: 220 })
  .map((entry, index) => toPolarisVisualElement(entry, index));
return JSON.stringify({
  visual: {
    title: clean(document.title || '', 300),
    url: String(location.href),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1
    },
    elements,
    screenshot: null
  },
  consoleMessages: (window.__POLARIS_BROWSER_CONSOLE__ || []).slice(-80)
});