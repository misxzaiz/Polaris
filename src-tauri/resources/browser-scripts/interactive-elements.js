(() => {
const elements = collectPolarisInteractiveElements({ viewportOnly: false, maxElements: 300 })
  .map((entry, index) => toPolarisInteractiveElement(entry, index));
return JSON.stringify(elements);
})()