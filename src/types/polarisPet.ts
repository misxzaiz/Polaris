/**
 * PolarisPet 类型定义
 *
 * 桌面宠物 + 编码成就系统
 */

/** 宠物情绪状态 */
export type PetMood =
  | 'idle'       // 发呆
  | 'happy'      // 开心（build 成功、成就达成）
  | 'sad'        // 难过（build 失败、报错）
  | 'thinking'   // 思考（AI 响应中）
  | 'excited'    // 兴奋（连续成就、大项目）
  | 'sleeping';  // 摸鱼（闲置一段时间后）

/** 宠物大小 */
export type PetSize = 'mini' | 'normal' | 'large';

/** 宠物配置 */
export interface PetConfig {
  enabled: boolean;
  size: PetSize;
  opacity: number;
  /** 闲置 X 秒后进入 sleeping 状态 */
  idleTimeoutSeconds: number;
}

/** 成就定义 */
export interface Achievement {
  id: string;
  /** 成就名称 */
  name: string;
  /** 成就描述 */
  description: string;
  /** 图标 emoji */
  icon: string;
  /** 达成条件类型 */
  condition: AchievementCondition;
  /** 达成条件所需的阈值 */
  threshold: number;
  /** 是否已解锁 */
  unlocked: boolean;
  /** 解锁时间 */
  unlockedAt?: number;
  /** 当前进度（0~threshold） */
  progress: number;
}

/** 成就条件类型 */
export type AchievementCondition =
  | 'chat_count'        // 聊天次数
  | 'build_count'       // 构建次数
  | 'tool_call_count'   // 工具调用次数
  | 'file_edit_count'   // 文件编辑次数
  | 'code_lines'        // 生成代码行数
  | 'session_count'     // 会话数量
  | 'engine_switch'     // 切换引擎次数
  | 'continuous_days';  // 连续使用天数

/** 可触发宠物反应的事件 */
export type PetEvent =
  | 'build_success'
  | 'build_fail'
  | 'ai_start'
  | 'ai_complete'
  | 'achievement_unlock'
  | 'idle_timeout';