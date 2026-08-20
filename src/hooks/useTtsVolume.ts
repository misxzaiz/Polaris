/**
 * useTtsVolume - TTS 播放实时音量（0-1）
 *
 * 经 AudioContext + AnalyserNode 分析 ttsService 当前 Audio 元素的频域能量，
 * 驱动 VoiceOrb 说话律动。ttsService 每句新建 Audio 元素，本 hook 在 rAF
 * 循环中检测元素变化并重新挂载分析节点。
 *
 * 降级策略：createMediaElementSource 失败（重复挂载/WebView 限制）时回退
 * 正弦+噪声模拟律动，保证视觉不缺失。
 *
 * 渲染节流：~80ms 间隔且变化量 >0.04 才 setState，避免全屏组件每帧重渲。
 */

import { useEffect, useState } from 'react';
import { ttsService } from '@/services/ttsService';
import { createLogger } from '@/utils/logger';

const log = createLogger('useTtsVolume');

/** setState 最小间隔（毫秒） */
const UPDATE_INTERVAL_MS = 80;
/** 触发更新的最小音量变化 */
const UPDATE_THRESHOLD = 0.04;

/**
 * 模块级共享 AudioContext：浏览器对实例数有上限（~6），且已挂载
 * MediaElementSource 的元素随 ctx 关闭会静音，故全局复用一个、永不关闭。
 */
let sharedCtx: AudioContext | null = null;
function getSharedCtx(): AudioContext {
  if (!sharedCtx) sharedCtx = new AudioContext();
  return sharedCtx;
}

export function useTtsVolume(active: boolean): number {
  const [volume, setVolume] = useState(0);

  useEffect(() => {
    if (!active) {
      setVolume(0);
      return;
    }

    let raf = 0;
    let analyser: AnalyserNode | null = null;
    let data: Uint8Array | null = null;
    let attachedEl: HTMLAudioElement | null = null;
    let analyserBroken = false; // 挂载失败 → 本元素降级模拟
    let lastEmit = 0;
    let lastValue = 0;
    let fallbackPhase = 0;

    const attach = (el: HTMLAudioElement) => {
      attachedEl = el;
      analyser = null;
      analyserBroken = false;
      try {
        const ctx = getSharedCtx();
        const source = ctx.createMediaElementSource(el);
        const node = ctx.createAnalyser();
        node.fftSize = 256;
        source.connect(node);
        node.connect(ctx.destination); // MediaElementSource 接管输出，必须回连扬声器
        analyser = node;
        data = new Uint8Array(node.frequencyBinCount);
      } catch (e) {
        // 已被挂载过或环境不支持 → 降级模拟律动
        analyserBroken = true;
        log.debug('AnalyserNode 挂载失败，降级模拟律动', { error: String(e) });
      }
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);

      const el = ttsService.getCurrentAudio();
      if (el && el !== attachedEl) attach(el);

      let next = 0;
      if (el && !el.paused) {
        if (analyser && data && !analyserBroken) {
          analyser.getByteFrequencyData(data as Uint8Array<ArrayBuffer>);
          let sum = 0;
          for (let i = 0; i < data.length; i++) sum += data[i];
          next = Math.min(1, sum / data.length / 110);
        } else {
          // 模拟：缓慢正弦 + 轻噪声
          fallbackPhase += 0.18;
          next = 0.4 + Math.sin(fallbackPhase) * 0.25 + Math.random() * 0.12;
        }
      }

      if (now - lastEmit >= UPDATE_INTERVAL_MS && Math.abs(next - lastValue) > UPDATE_THRESHOLD) {
        lastEmit = now;
        lastValue = next;
        setVolume(next);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      setVolume(0);
    };
  }, [active]);

  return volume;
}
