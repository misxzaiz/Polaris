/**
 * ProgressiveStreamingMarkdown 流式光标回归测试
 *
 * 背景：AI 文本以段落边界（\n\n）结束时，流式分割会多出一个空尾段，
 * 该空段被当作"最后一段流式中"渲染，导致空行上出现持续闪烁的打字光标
 * （尤其在文本结束 → 工具调用开始之间，isStreaming 仍为 true，光标不消失）。
 *
 * 修复契约：
 * - content 以 \n\n 结尾（段落边界已完成）→ 整块按已完成渲染，不挂流式光标
 * - 正常流式中途（末段非空）→ 光标仍出现在最后一段字符末尾
 * - 非流式（completed=true）→ 永不出现光标
 * - LightweightMarkdown 空/纯空白 content → 不渲染光标（防御）
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProgressiveStreamingMarkdown, LightweightMarkdown } from './lightweightMarkdown';

const CARET = 'streaming-caret';

describe('ProgressiveStreamingMarkdown 流式光标', () => {
  it('流式中：content 以 \\n\\n 结尾（段落边界已完成）→ 不渲染光标', () => {
    const html = renderToStaticMarkup(
      <ProgressiveStreamingMarkdown content={'段落1\n\n段落2\n\n'} />
    );
    expect(html).not.toContain(CARET);
  });

  it('流式中：单段未结束 → 光标出现在字符末尾', () => {
    const html = renderToStaticMarkup(
      <ProgressiveStreamingMarkdown content={'正在输入的文字'} />
    );
    expect(html).toContain(CARET);
  });

  it('流式中：多段且最后一段非空 → 光标保留在末段', () => {
    const html = renderToStaticMarkup(
      <ProgressiveStreamingMarkdown content={'段落1\n\n段落2\n\n正在输入的第三段'} />
    );
    expect(html).toContain(CARET);
    // 已完成段落（前两段）已完整渲染，不含未闭合内容
    expect(html).toContain('段落1');
    expect(html).toContain('段落2');
  });

  it('流式中：以 \\n\\n 结尾但有块级元素 → 不渲染光标且保留段落结构', () => {
    const html = renderToStaticMarkup(
      <ProgressiveStreamingMarkdown content={'# 标题\n\n段落2\n\n'} />
    );
    expect(html).not.toContain(CARET);
    expect(html).toContain('h1');
  });

  it('非流式（completed=true）：无论是否 \\n\\n 结尾都不渲染光标', () => {
    const completed = renderToStaticMarkup(
      <ProgressiveStreamingMarkdown content={'段落1\n\n段落2\n\n'} completed />
    );
    const inProgress = renderToStaticMarkup(
      <ProgressiveStreamingMarkdown content={'段落1\n\n段落2'} completed />
    );
    expect(completed).not.toContain(CARET);
    expect(inProgress).not.toContain(CARET);
  });

  it('含代码块路径：代码块后文本以 \\n\\n 结尾 → 不渲染光标', () => {
    const html = renderToStaticMarkup(
      <ProgressiveStreamingMarkdown content={'```js\ncode\n```\n\n结尾文本\n\n'} />
    );
    expect(html).not.toContain(CARET);
  });
});

describe('LightweightMarkdown 光标防御', () => {
  it('空 content 即使 caret=true 也不渲染光标', () => {
    const html = renderToStaticMarkup(<LightweightMarkdown content="" caret />);
    expect(html).not.toContain(CARET);
  });

  it('纯空白 content 即使 caret=true 也不渲染光标', () => {
    // JSX 属性值里 \n 是字面量反斜杠+n，不是换行；必须用表达式传入真空白
    const html = renderToStaticMarkup(<LightweightMarkdown content={'  \n  '} caret />);
    expect(html).not.toContain(CARET);
  });

  it('正常 content 仍渲染光标', () => {
    const html = renderToStaticMarkup(<LightweightMarkdown content="输入中" caret />);
    expect(html).toContain(CARET);
  });
});
