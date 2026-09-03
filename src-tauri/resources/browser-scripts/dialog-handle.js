/**
 * 原生对话框（alert/confirm/prompt/beforeunload）拦截与应答。
 * 从 window.__POLARIS_DIALOG_ARGS__ 读参：{ op: 'install'|'respond'|'list'|'clear', accept?: boolean, promptText?: string }
 *
 * install：页面加载前注入，把 window.alert/confirm/prompt 替换为收集器，
 *          对话框消息进入 window.__POLARIS_DIALOG_QUEUE__，不阻塞 JS 主线程。
 * respond：对队列中的下一条 pending 对话框给出应答（accept / dismiss / promptText）。
 * list   ：读取当前队列（含已应答历史）。
 * clear  ：清空队列。
 */
(() => {
  const args = window.__POLARIS_DIALOG_ARGS__ || {};
  delete window.__POLARIS_DIALOG_ARGS__;
  const op = args.op || 'list';

  if (op === 'install') {
    if (window.__POLARIS_DIALOG_INSTALLED__) {
      return JSON.stringify({ ok: true, installed: false, message: '对话框拦截已安装' });
    }
    const queue = [];
    let seq = 0;
    // 待应答队列:AI 通过 respond 操作给值
    window.__POLARIS_DIALOG_QUEUE__ = queue;
    window.__POLARIS_DIALOG_RESPOND__ = (id, accept, promptText) => {
      const item = queue.find((q) => q.id === id && q.pending);
      if (!item) return false;
      item.pending = false;
      item.accept = accept !== false;
      if (typeof promptText === 'string') item.promptText = promptText;
      return true;
    };
    const record = (type, message) => {
      const item = { id: ++seq, type, message: String(message || ''), pending: true, timestamp: Date.now() };
      queue.push(item);
      if (queue.length > 50) queue.splice(0, queue.length - 50);
      return item;
    };
    window.alert = (msg) => { record('alert', msg); };
    window.confirm = (msg) => {
      const item = record('confirm', msg);
      // 同步语义无法真正等待异步应答；默认 accept，AI 可事后通过队列审计
      item.pending = false;
      item.accept = true;
      return true;
    };
    window.prompt = (msg, def) => {
      const item = record('prompt', msg);
      item.pending = false;
      item.accept = true;
      item.promptText = def == null ? '' : String(def);
      return item.promptText;
    };
    // beforeunload 只记录不阻止（阻止会破坏正常导航）
    window.addEventListener('beforeunload', (event) => {
      record('beforeunload', event.returnValue || '页面尝试离开');
    });
    window.__POLARIS_DIALOG_INSTALLED__ = true;
    return JSON.stringify({ ok: true, installed: true, message: '对话框拦截已安装（alert/confirm/prompt 将被记录而非弹出）' });
  }

  const queue = window.__POLARIS_DIALOG_QUEUE__ || [];

  if (op === 'respond') {
    const accept = args.accept !== false;
    const promptText = typeof args.promptText === 'string' ? args.promptText : undefined;
    // 优先应答 pending 的第一条，否则对最近一条补登记
    const target = queue.find((q) => q.pending) || queue[queue.length - 1];
    if (!target) {
      return JSON.stringify({ ok: false, message: '当前没有可应答的对话框' });
    }
    if (target.pending) {
      target.pending = false;
      target.accept = accept;
      if (promptText !== undefined) target.promptText = promptText;
    }
    return JSON.stringify({ ok: true, message: `已应答对话框 #${target.id}（${accept ? 'accept' : 'dismiss'}）`, dialog: target });
  }

  if (op === 'clear') {
    queue.length = 0;
    return JSON.stringify({ ok: true, message: '对话框队列已清空' });
  }

  // list
  return JSON.stringify({
    ok: true,
    installed: !!window.__POLARIS_DIALOG_INSTALLED__,
    count: queue.length,
    items: queue.slice(-20),
  });
})()
