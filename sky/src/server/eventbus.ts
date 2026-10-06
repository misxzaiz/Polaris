/**
 * EventBus — 能力事件广播
 *
 * 简单可靠: 保留最近 1000 条历史(供 resume/gap 检测), 订阅者 fan-out.
 * 发行版可换成带 ring buffer + gap 检测的版本.
 */

import type { CapabilityEvent } from '../contracts.ts';

type Subscriber = (event: CapabilityEvent) => void;

export class EventBus {
  private subs = new Map<string, Subscriber>();
  private history: CapabilityEvent[] = [];
  private readonly maxHistory = 1000;

  subscribe(id: string, fn: Subscriber): () => void {
    this.subs.set(id, fn);
    return () => this.subs.delete(id);
  }

  emit(event: CapabilityEvent): void {
    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
    for (const fn of this.subs.values()) {
      try { fn(event); } catch { /* 订阅者异常不影响广播 */ }
    }
  }

  /** 拉取 seq 之后的事件(供 WS resume) */
  since(seq: number): CapabilityEvent[] {
    return this.history.slice(seq);
  }

  /** 清空历史 */
  clear(): void {
    this.history.length = 0;
  }

  get length(): number { return this.history.length; }
  get subscriberCount(): number { return this.subs.size; }
}
