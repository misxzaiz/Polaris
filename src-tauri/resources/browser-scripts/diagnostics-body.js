(() => {
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
})()