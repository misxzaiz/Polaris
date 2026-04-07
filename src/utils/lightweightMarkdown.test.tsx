/**
 * 轻量级 Markdown 渲染器测试
 */

import { describe, it, expect } from 'vitest';
import {
  parseInlineMarkdown,
  hasOpenCodeBlock,
  splitByCodeBlocks,
} from './lightweightMarkdown';

// 测试 parseInlineMarkdown 内部逻辑
// 由于函数未导出，我们通过 LightweightMarkdown 组件间接测试
// 但为了更好的单元测试覆盖，我们需要测试核心解析逻辑

// 从模块中提取测试函数
import { LightweightMarkdown } from './lightweightMarkdown';
import { renderToStaticMarkup } from 'react-dom/server';

describe('parseInlineMarkdown (via LightweightMarkdown)', () => {
  describe('plain text', () => {
    it('should render plain text unchanged', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="Hello World" />);
      expect(result).toBe('<span class="whitespace-pre-wrap break-words">Hello World</span>');
    });

    it('should handle empty string', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="" />);
      expect(result).toBe('<span class="whitespace-pre-wrap break-words"></span>');
    });

    it('should handle whitespace', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="  spaces  " />);
      expect(result).toBe('<span class="whitespace-pre-wrap break-words">  spaces  </span>');
    });

    it('should handle special characters (escaped by React)', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="Test @#$%^&*(){}[]|:" />);
      // React 会转义 HTML 特殊字符：& -> &amp;
      expect(result).toContain('Test @#$%^&amp;*(){}[]|:');
    });
  });

  describe('bold text', () => {
    it('should render **bold** text', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="This is **bold** text" />);
      expect(result).toContain('<strong>bold</strong>');
    });

    it('should render __bold__ text', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="This is __bold__ text" />);
      expect(result).toContain('<strong>bold</strong>');
    });

    it('should handle multiple bold sections', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="**first** and **second**" />);
      expect(result).toContain('<strong>first</strong>');
      expect(result).toContain('<strong>second</strong>');
    });

    it('should handle unclosed bold markers', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="This **is unclosed" />);
      // 未闭合的标记应该作为普通文本处理
      expect(result).toContain('**is unclosed');
    });

    it('should handle bold with empty content', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="****" />);
      // 空的粗体内容
      expect(result).toContain('**');
    });
  });

  describe('italic text', () => {
    it('should render *italic* text', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="This is *italic* text" />);
      expect(result).toContain('<em>italic</em>');
    });

    it('should render _italic_ text', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="This is _italic_ text" />);
      expect(result).toContain('<em>italic</em>');
    });

    it('should handle multiple italic sections', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="*first* and *second*" />);
      expect(result).toContain('<em>first</em>');
      expect(result).toContain('<em>second</em>');
    });

    it('should handle unclosed italic markers', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="This *is unclosed" />);
      expect(result).toContain('*is unclosed');
    });
  });

  describe('inline code', () => {
    it('should render `code` text', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="Use `console.log` here" />);
      expect(result).toContain('<code');
      expect(result).toContain('console.log');
      expect(result).toContain('</code>');
    });

    it('should handle multiple code sections', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="Use `foo` and `bar`" />);
      expect(result).toContain('foo');
      expect(result).toContain('bar');
    });

    it('should handle unclosed code markers', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="This `is unclosed" />);
      expect(result).toContain('`is unclosed');
    });

    it('should handle code with special characters (escaped by React)', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="`if (x > 0)`" />);
      // React 会转义 > 为 &gt;
      expect(result).toContain('if (x &gt; 0)');
    });
  });

  describe('links', () => {
    it('should render [text](url) links', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="Click [here](https://example.com)" />);
      expect(result).toContain('<a href="https://example.com"');
      expect(result).toContain('target="_blank"');
      expect(result).toContain('rel="noopener noreferrer"');
      expect(result).toContain('>here</a>');
    });

    it('should handle multiple links', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="[link1](url1) and [link2](url2)" />);
      expect(result).toContain('href="url1"');
      expect(result).toContain('href="url2"');
    });

    it('should handle link with special characters in URL', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="[docs](https://example.com/path?query=value&other=123)" />);
      expect(result).toContain('href="https://example.com/path?query=value&amp;other=123"');
    });

    it('should handle malformed link syntax', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="This [is not a link" />);
      expect(result).toContain('[is not a link');
    });
  });

  describe('strikethrough', () => {
    it('should render ~~strikethrough~~ text', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="This is ~~deleted~~ text" />);
      expect(result).toContain('<del>deleted</del>');
    });

    it('should handle multiple strikethrough sections', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="~~first~~ and ~~second~~" />);
      expect(result).toContain('<del>first</del>');
      expect(result).toContain('<del>second</del>');
    });

    it('should handle unclosed strikethrough markers', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="This ~~is unclosed" />);
      expect(result).toContain('~~is unclosed');
    });
  });

  describe('combined formatting', () => {
    it('should handle bold and italic together', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="**bold** and *italic*" />);
      expect(result).toContain('<strong>bold</strong>');
      expect(result).toContain('<em>italic</em>');
    });

    it('should handle all formats together', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="**bold** *italic* `code` [link](url) ~~strike~~" />);
      expect(result).toContain('<strong>bold</strong>');
      expect(result).toContain('<em>italic</em>');
      expect(result).toContain('<code');
      expect(result).toContain('<a href="url"');
      expect(result).toContain('<del>strike</del>');
    });

    it('should handle mixed content correctly', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="Text with **bold** and more text" />);
      expect(result).toContain('Text with ');
      expect(result).toContain('<strong>bold</strong>');
      expect(result).toContain(' and more text');
    });
  });

  describe('edge cases', () => {
    it('should handle very long content', () => {
      const longText = 'a'.repeat(100000);
      const result = renderToStaticMarkup(<LightweightMarkdown content={longText} />);
      // 超过 50KB 应该直接返回原文本
      expect(result).toContain('a'.repeat(100000));
    });

    it('should handle content at boundary (50KB)', () => {
      const text = 'a'.repeat(50000);
      const result = renderToStaticMarkup(<LightweightMarkdown content={text} />);
      expect(result).toContain('a');
    });

    it('should handle nested markers (treated as separate)', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="**bold *italic* bold**" />);
      // 嵌套格式 - 外层粗体，内层可能被解析为斜体
      expect(result).toContain('<strong>');
    });

    it('should handle markers at string boundaries', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="**bold**" />);
      expect(result).toContain('<strong>bold</strong>');
    });

    it('should handle consecutive markers', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="**bold**`code`" />);
      expect(result).toContain('<strong>bold</strong>');
      expect(result).toContain('<code');
    });

    it('should handle Unicode content', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="**中文粗体** *日本語斜体*" />);
      expect(result).toContain('<strong>中文粗体</strong>');
      expect(result).toContain('<em>日本語斜体</em>');
    });
  });

  describe('security', () => {
    it('should not execute scripts in content', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="<script>alert('xss')</script>" />);
      // React 自动转义，脚本不会执行
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
    });

    it('should handle javascript: links (React blocks them)', () => {
      const result = renderToStaticMarkup(<LightweightMarkdown content="[click](javascript:alert('xss'))" />);
      // React 会替换 javascript: URL 为安全错误
      expect(result).toContain('React has blocked a javascript: URL');
    });
  });
});

describe('hasOpenCodeBlock', () => {
  it('should return false for no code blocks', () => {
    expect(hasOpenCodeBlock('no code blocks')).toBe(false);
  });

  it('should return false for closed code block', () => {
    expect(hasOpenCodeBlock('```\ncode\n```')).toBe(false);
  });

  it('should return true for open code block', () => {
    expect(hasOpenCodeBlock('```\ncode')).toBe(true);
  });

  it('should return false for two closed code blocks', () => {
    expect(hasOpenCodeBlock('```\ncode1\n```\n```\ncode2\n```')).toBe(false);
  });

  it('should return true for one closed and one open', () => {
    expect(hasOpenCodeBlock('```\ncode1\n```\n```\ncode2')).toBe(true);
  });

  it('should handle code block with language', () => {
    expect(hasOpenCodeBlock('```typescript\ncode')).toBe(true);
    expect(hasOpenCodeBlock('```typescript\ncode\n```')).toBe(false);
  });

  it('should handle multiple backticks', () => {
    expect(hasOpenCodeBlock('````\ncode\n````')).toBe(false);
    expect(hasOpenCodeBlock('```code```')).toBe(false);
  });

  it('should return true for odd number of backtick pairs', () => {
    expect(hasOpenCodeBlock('```one')).toBe(true);
    expect(hasOpenCodeBlock('```one```\n```two')).toBe(true);
    expect(hasOpenCodeBlock('```one```\n```two```\n```three')).toBe(true);
  });
});

describe('splitByCodeBlocks', () => {
  it('should return text part for no code blocks (incomplete)', () => {
    const result = splitByCodeBlocks('plain text');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'text', content: 'plain text', completed: false });
  });

  it('should split code block correctly', () => {
    const result = splitByCodeBlocks('before```\ncode\n```after');
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: 'text', content: 'before', completed: true });
    expect(result[1]).toEqual({ type: 'code-block', content: 'code\n', language: undefined, completed: true });
    expect(result[2]).toEqual({ type: 'text', content: 'after', completed: false });
  });

  it('should extract language from code block', () => {
    const result = splitByCodeBlocks('```typescript\ncode\n```');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'code-block', content: 'code\n', language: 'typescript', completed: true });
  });

  it('should handle multiple code blocks', () => {
    const result = splitByCodeBlocks('```js\none\n```\n```\ntwo\n```');
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: 'code-block', content: 'one\n', language: 'js', completed: true });
    expect(result[1]).toEqual({ type: 'text', content: '\n', completed: true });
    expect(result[2]).toEqual({ type: 'code-block', content: 'two\n', language: undefined, completed: true });
  });

  it('should handle open code block', () => {
    const result = splitByCodeBlocks('```\nunclosed code');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'text', content: '```\nunclosed code', completed: false });
  });

  it('should handle code block with language at end', () => {
    const result = splitByCodeBlocks('text```python\ncode\n```');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: 'text', content: 'text', completed: true });
    expect(result[1]).toEqual({ type: 'code-block', content: 'code\n', language: 'python', completed: true });
  });

  it('should handle empty code block', () => {
    const result = splitByCodeBlocks('```\n```');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'code-block', content: '', language: undefined, completed: true });
  });

  it('should handle code block with complex content', () => {
    const code = 'function test() {\n  return "hello";\n}';
    const result = splitByCodeBlocks(`\`\`\`javascript\n${code}\n\`\`\``);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'code-block', content: `${code}\n`, language: 'javascript', completed: true });
  });

  it('should handle text only (incomplete)', () => {
    const result = splitByCodeBlocks('Hello **world** and `code`');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'text', content: 'Hello **world** and `code`', completed: false });
  });

  it('should handle code block followed by text (incomplete)', () => {
    const result = splitByCodeBlocks('```js\ncode\n```end');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: 'code-block', content: 'code\n', language: 'js', completed: true });
    expect(result[1]).toEqual({ type: 'text', content: 'end', completed: false });
  });

  it('should handle text before open code block', () => {
    const result = splitByCodeBlocks('intro text\n```python\nprint("hello")');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: 'text', content: 'intro text\n', completed: true });
    expect(result[1]).toEqual({ type: 'text', content: '```python\nprint("hello")', completed: false });
  });

  it('should handle closed then open code block', () => {
    const result = splitByCodeBlocks('```js\none\n```\nbetween\n```py\ntwo');
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: 'code-block', content: 'one\n', language: 'js', completed: true });
    expect(result[1]).toEqual({ type: 'text', content: '\nbetween\n', completed: true });
    expect(result[2]).toEqual({ type: 'text', content: '```py\ntwo', completed: false });
  });

  // Mermaid 块测试
  it('should detect mermaid block correctly', () => {
    const result = splitByCodeBlocks('```mermaid\ngraph TD\n  A --> B\n```');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'mermaid-block', content: 'graph TD\n  A --> B', completed: true });
  });

  it('should split text and mermaid block', () => {
    const result = splitByCodeBlocks('before\n```mermaid\ngraph TD\n  A --> B\n```after');
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: 'text', content: 'before\n', completed: true });
    expect(result[1]).toEqual({ type: 'mermaid-block', content: 'graph TD\n  A --> B', completed: true });
    expect(result[2]).toEqual({ type: 'text', content: 'after', completed: false });
  });

  it('should handle mermaid block with code block', () => {
    const result = splitByCodeBlocks('```mermaid\ngraph A\n```\n```js\ncode\n```');
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: 'mermaid-block', content: 'graph A', completed: true });
    expect(result[1]).toEqual({ type: 'text', content: '\n', completed: true });
    expect(result[2]).toEqual({ type: 'code-block', content: 'code\n', language: 'js', completed: true });
  });

  it('should handle mermaid block with extra spaces', () => {
    const result = splitByCodeBlocks('``` mermaid\ngraph TD\n```');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'mermaid-block', content: 'graph TD', completed: true });
  });
});
