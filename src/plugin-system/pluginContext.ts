/**
 * 插件执行上下文（ai-chat-plugin-extraction-spec P1.3）
 *
 * 宿主桥（__POLARIS_HOST_LISTEN__ 等）需要知道「当前是哪个插件在调用」才能按
 * manifest permissions 裁决（如 chat-event 的 full/lifecycle/none 授权）。
 * 插件与宿主同 window 运行、调用是同步函数边界，无法从调用栈推断来源——
 * 用模块级栈（load/unload 配对）在面板模块加载期间标记当前插件。
 *
 * 栈语义：面板 loader 执行（同步 import）期间 push，加载完成/失败 pop；
 * 嵌套加载（插件 A 的 bundle 动态 import 插件 B 的模块）按栈顶取值。
 */

let stack: string[] = []

export function pushPluginContext(pluginId: string): void {
  stack.push(pluginId)
}

export function popPluginContext(pluginId: string): void {
  // 配对弹出（防乱序）：只弹最近的同名标记
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i] === pluginId) {
      stack.splice(i, 1)
      return
    }
  }
}

/** 当前正在加载/执行的插件 id（无上下文返回 undefined） */
export function currentPluginContext(): string | undefined {
  return stack[stack.length - 1]
}

/** 测试辅助：重置栈（仅测试用） */
export function resetPluginContext(): void {
  stack = []
}
