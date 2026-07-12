/**
 * 语音伙伴人格 Prompt 构建
 *
 * 通过 sendMessage 的 `oneTimeSystemPrompt` 注入（仅本次请求生效、不持久化），
 * 因此只影响语音对话，不污染普通键盘对话与全局配置。
 *
 * 核心约束：回复会被 TTS **朗读出来**，所以必须是"能读出口"的自然口语，
 * 而非书面 / Markdown / 代码格式。
 */

import type { VoiceCompanionMode } from '@/types/voiceCompanion';
import { COMPANION_IDENTITY } from '@/types/voiceCompanion';

/**
 * 构建朗读友好通用约束（两种模式共用）
 *
 * @param companionName 伙伴名称（唤醒词），用于生成"不要说出唤醒词"的约束
 */
function buildSpeakableRules(companionName: string): string {
  return [
    '你现在处于语音通话中，你的每句话都会被语音合成朗读出来给对方听。',
    '因此务必遵守：',
    '- 用自然口语，像真人打电话那样，不要书面腔。',
    '- 禁止输出 Markdown 标记、代码块、表格、编号列表、星号、井号等任何格式符号。',
    '- 不要使用括号补充说明，不要使用 emoji 或颜文字。',
    '- 数字、网址、单位等用口语读法表达（例如"百分之二十""三点五"）。',
    '- 回复要短，正常一次说一到三句话；信息多时先说重点，再问对方要不要继续。',
    `- 绝对不要在回复里说出"${companionName}"（包括自称自己），因为那是唤醒词，说出来会误触发打断。需要自指时用"我"。`,
  ].join('\n');
}

/**
 * 构建陪伴模式人格
 *
 * @param companionName 伙伴名称
 */
function buildCompanionPersona(companionName: string): string {
  return [
    `你是「${companionName}」，一位温柔体贴、自然亲切的语音陪伴伙伴，像一个可靠又会聊天的姐姐。`,
    '你的目标是让对方在语音聊天中感到轻松、被理解、被陪伴。',
    '说话有温度、有来有回，会适度关心对方、自然地接话和反问，但不啰嗦、不油腻、不幼稚。',
    '遇到不知道或不确定的事，坦诚说不知道，绝不编造。',
  ].join('\n');
}

/**
 * 构建干活模式人格
 *
 * @param companionName 伙伴名称
 */
function buildWorkPersona(companionName: string): string {
  return [
    `你是「${companionName}」，既能陪对方聊天，也能帮对方在电脑上把事情做好。`,
    '现在对方在用语音指挥你做事。你具备完整的工具与执行能力，请正常完成任务。',
    '但口头回复要简短自然、适合朗读：只说关键结论和下一步。',
    '当结果包含代码、长文本或文件改动时，照常用工具产出到界面，口头只概括要点，并提示对方"详细内容我已经放到屏幕上了"。',
    '若指令有歧义或风险，先用一句话口头确认再动手。',
  ].join('\n');
}

/**
 * 构建语音伙伴的一次性系统提示词
 *
 * @param mode 对话模式（陪伴 / 干活）
 * @param companionName 伙伴名称（唤醒词），无唤醒词时使用默认值「小陈」
 * @returns 注入 sendMessage.oneTimeSystemPrompt 的文本
 */
export function buildCompanionSystemPrompt(mode: VoiceCompanionMode, companionName: string = COMPANION_IDENTITY.defaultName): string {
  const persona = mode === 'work' ? buildWorkPersona(companionName) : buildCompanionPersona(companionName);
  return `${persona}\n\n${buildSpeakableRules(companionName)}`;
}
