/**
 * 收集页面可交互元素并序列化返回。
 * 注意：此文件是 body（不含 IIFE），由 browser_scripts::with_collector 注入 collector 后包裹执行。
 */
const elements = collectPolarisInteractiveElements({ viewportOnly: false, maxElements: 300 })
  .map((entry, index) => toPolarisInteractiveElement(entry, index));
return JSON.stringify(elements);
