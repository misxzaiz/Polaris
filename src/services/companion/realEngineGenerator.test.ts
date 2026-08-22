/**
 * RealEngineContentGenerator — 单元测试
 *
 * 覆盖：extractJSON 解析、JSON 格式兼容性
 * 注：真实引擎调用依赖 sessionStoreManager，需集成测试环境
 */

import { describe, it, expect } from 'vitest';
import { extractJSON } from './realEngineGenerator';

describe('extractJSON', () => {
  it('应解析纯 JSON 对象', () => {
    const text = '{"title": "测试", "body": "内容"}';
    const result = extractJSON(text);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('测试');
    expect(result!.body).toBe('内容');
  });

  it('应解析 Markdown 代码块包装的 JSON', () => {
    const text = '```json\n{"title": "测试", "body": "内容"}\n```';
    const result = extractJSON(text);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('测试');
  });

  it('应解析无语言标记的代码块', () => {
    const text = '```\n{"title": "测试", "body": "内容"}\n```';
    const result = extractJSON(text);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('测试');
  });

  it('应解析正文前后有额外文字', () => {
    const text = '根据分析，以下是推荐内容：\n\n{"title": "项目洞察", "body": "建议优化", "evidence": ["ctx1"]}\n\n祝好！';
    const result = extractJSON(text);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('项目洞察');
  });

  it('嵌套对象应正确解析', () => {
    const text = '{"title": "A", "body": "B", "action": {"label": "开始", "payload": "start"}}';
    const result = extractJSON(text);
    expect(result).not.toBeNull();
    expect(result!.action).toEqual({ label: '开始', payload: 'start' });
  });

  it('无 JSON 时返回 null', () => {
    expect(extractJSON('纯文本回复，没有 JSON')).toBeNull();
  });

  it('空字符串返回 null', () => {
    expect(extractJSON('')).toBeNull();
  });

  it('不完整 JSON 返回 null', () => {
    expect(extractJSON('{"title": "测试"')).toBeNull();
  });
});