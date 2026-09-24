/**
 * injectCaretIntoLastBlock 单测 —— 锁定 caret 注入位置的正确性。
 *
 * 关键约束：caret 必须出现在 marked 渲染结果中"最后一个块级元素"内部
 * （</p> / </li> / </h1-6> 等闭合标签之前），而非容器末尾。
 * 否则 caret 会视觉上落到最后一行的下方，而不是字符末尾。
 */
import { describe, it, expect } from 'vitest';
import { injectCaretIntoLastBlock } from './lightweightMarkdown';

const CARET_SPAN = '<span class="streaming-caret" aria-hidden="true"></span>';

describe('injectCaretIntoLastBlock', () => {
  it('caret 插入到最后一个 </p> 内部（而非容器末尾）', () => {
    const html = '<p>第一段</p>\n<p>最后一段</p>';
    const result = injectCaretIntoLastBlock(html);
    // 最后一个 </p> 应该出现在 caret span 之后
    const caretStart = result.indexOf(CARET_SPAN);
    const caretEnd = caretStart + CARET_SPAN.length;
    expect(result.slice(caretEnd)).toBe('</p>');
  });

  it('caret 插入到最后一个 </li> 内部（列表末尾）', () => {
    const html = '<ul><li>项目1</li><li>项目2</li></ul>';
    const result = injectCaretIntoLastBlock(html);
    const caretStart = result.indexOf(CARET_SPAN);
    const caretEnd = caretStart + CARET_SPAN.length;
    // caret 之后是 </li></ul>
    expect(result.slice(caretEnd)).toBe('</li></ul>');
  });

  it('caret 插入到 </h3> 内部（标题末尾）', () => {
    const html = '<p>前言</p>\n<h3>标题</h3>';
    const result = injectCaretIntoLastBlock(html);
    const caretStart = result.indexOf(CARET_SPAN);
    const caretEnd = caretStart + CARET_SPAN.length;
    expect(result.slice(caretEnd)).toBe('</h3>');
  });

  it('caret 出现在 <strong> 之后但仍在 </p> 内（行内元素末尾）', () => {
    const html = '<p>这是<strong>粗体</strong></p>';
    const result = injectCaretIntoLastBlock(html);
    const caretStart = result.indexOf(CARET_SPAN);
    // caret 之前是 </strong>
    expect(result.slice(caretStart - '</strong>'.length, caretStart)).toBe('</strong>');
    const caretEnd = caretStart + CARET_SPAN.length;
    expect(result.slice(caretEnd)).toBe('</p>');
  });

  it('无块级元素时退化到末尾追加', () => {
    const html = '<code>x</code>';
    const result = injectCaretIntoLastBlock(html);
    expect(result).toBe(`<code>x</code>${CARET_SPAN}`);
  });

  it('多段落场景 caret 只出现在最后一段', () => {
    const html = '<p>a</p><p>b</p><p>c</p>';
    const result = injectCaretIntoLastBlock(html);
    // 只出现一次 caret
    const count = result.split(CARET_SPAN).length - 1;
    expect(count).toBe(1);
    // 紧跟 "c" 之后
    expect(result).toContain(`c${CARET_SPAN}`);
  });
});
