/**
 * 思考内容步骤提取
 */

import type { ThinkingStep } from './types';

/**
 * 从思考内容中提取关键步骤
 * 支持多种格式的步骤标记
 */
export function extractThinkingSteps(content: string): ThinkingStep[] {
  if (!content || content.length < 50) return [];

  const lines = content.split('\n');
  const steps: ThinkingStep[] = [];
  let stepIndex = 0;

  // 步骤匹配模式
  const patterns = [
    // 数字编号: 1. xxx, 1) xxx, 1、xxx
    /^(\d+)[.)、]\s*(.+)$/,
    // 中文步骤词: 首先, 其次, 然后, 最后
    /^(首先|其次|然后|接着|最后)[：:\s]+(.+)$/,
    // 步骤标记: 第一步, 第二步, etc.
    /^(第[一二三四五六七八九十]+步)[：:\s]*(.*)$/,
    // 英文步骤: First, Second, Then, Finally
    /^(First|Second|Third|Then|Next|Finally)[,:]\s*(.+)$/i,
    // 破折号列表: - xxx, • xxx
    /^[-•]\s*(.+)$/,
    // 星号列表: * xxx
    /^\*\s*(.+)$/,
  ];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 5) continue;

    for (const pattern of patterns) {
      const match = trimmed.match(pattern);
      if (match) {
        // 数字编号模式
        if (match[1] && /^\d+$/.test(match[1])) {
          const num = parseInt(match[1], 10);
          // 只提取前10个步骤，避免提取代码行号
          if (num <= 10 && num > 0) {
            steps.push({
              text: match[2].trim(),
              index: stepIndex++
            });
          }
        } else if (match[2]) {
          // 其他模式
          steps.push({
            text: match[2].trim(),
            index: stepIndex++
          });
        } else if (match[1] && !/^\d+$/.test(match[1])) {
          // 破折号/星号列表
          steps.push({
            text: match[1].trim(),
            index: stepIndex++
          });
        }
        break;
      }
    }

    // 最多提取8个步骤
    if (steps.length >= 8) break;
  }

  return steps;
}
