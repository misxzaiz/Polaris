/**
 * isLikelyEcho 回声相似度判定测试
 *
 * 场景：语音伙伴 TTS 朗读期间/结束后，ASR 把扬声器播出的内容识别为输入。
 * 判定需耐受 ASR 同音错字与断句重组（bigram containment ≥ 0.6）。
 */

import { describe, it, expect } from 'vitest';
import { isLikelyEcho } from './speech';

describe('isLikelyEcho', () => {
  const speaking = '嗯嗯，我帮你看看哦。今天上午有两个会，下午我帮你留了整块时间写代码。';

  it('精确子串回声 → 判定为回声', () => {
    expect(isLikelyEcho('我帮你看看哦', speaking)).toBe(true);
    expect(isLikelyEcho('今天上午有两个会', speaking)).toBe(true);
  });

  it('标点/空白差异不影响判定', () => {
    expect(isLikelyEcho('我帮你看看哦。', speaking)).toBe(true);
    expect(isLikelyEcho('今天 上午 有 两个会', speaking)).toBe(true);
  });

  it('ASR 同音错字（少量字符替换）仍判定为回声', () => {
    // 哦→喔
    expect(isLikelyEcho('我帮你看看喔', speaking)).toBe(true);
    // 会→汇
    expect(isLikelyEcho('今天上午有两个汇', speaking)).toBe(true);
  });

  it('跨句重组的回声片段仍判定为回声', () => {
    expect(isLikelyEcho('下午我帮你留了整块时间', speaking)).toBe(true);
  });

  it('语义无关的用户输入 → 不是回声', () => {
    expect(isLikelyEcho('帮我打开设置页面', speaking)).toBe(false);
    expect(isLikelyEcho('现在几点了', speaking)).toBe(false);
    expect(isLikelyEcho('小陈', speaking)).toBe(false);
  });

  it('与朗读内容部分重叠但主体不同的指令 → 不是回声', () => {
    // 包含"写代码"二字但整体是新指令
    expect(isLikelyEcho('帮我新建一个文件开始重构项目', speaking)).toBe(false);
  });

  it('空输入/空指纹 → 不是回声', () => {
    expect(isLikelyEcho('', speaking)).toBe(false);
    expect(isLikelyEcho('我帮你看看', '')).toBe(false);
    expect(isLikelyEcho('', '')).toBe(false);
  });

  it('阈值可调：高阈值收紧判定', () => {
    // 同音错字样例在 bigram 命中率约 0.8，阈值 0.9 时不再判回声
    expect(isLikelyEcho('我帮你看看喔', speaking, 0.9)).toBe(false);
  });
});
