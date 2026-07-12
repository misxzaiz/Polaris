/**
 * Skill 类型定义
 *
 * Skill 是 Markdown 文件，位于配置的目录中（如 .polaris/skills/<name>/SKILL.md、.polaris/agents/<name>.md）。
 * 前端扫描后用于在 / 命令中展示和注入引用。
 */

/** 单个 Skill 条目 */
export interface SkillItem {
  /** 唯一标识（文件名，不含扩展名） */
  id: string;
  /** 显示名称（优先用 # 标题，无则用文件名） */
  name: string;
  /** 简短描述（第一个非空段落） */
  description?: string;
  /** 来源文件绝对路径 */
  filePath: string;
  /** 文件最后修改时间戳（ms） */
  mtime: number;
}

/** Skill 目录配置：一个目录路径的配置 */
export interface SkillPathConfig {
  path: string;
  /** 路径类型 */
  type: 'global' | 'workspace';
}