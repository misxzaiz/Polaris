/**
 * Engine 配置验证器
 *
 * 提供统一的配置验证机制，不依赖第三方库。
 *
 * 设计原则：
 * 1. 类型安全 - 使用 TypeScript 类型系统
 * 2. 轻量级 - 无第三方依赖
 * 3. 可扩展 - 支持自定义验证规则
 * 4. 统一错误 - 标准化的验证结果
 */

/**
 * 验证错误类型
 */
export type ValidationErrorType =
  | 'required'
  | 'type_mismatch'
  | 'invalid_value'
  | 'out_of_range'
  | 'format_error'
  | 'custom'

/**
 * 验证错误
 */
export interface ValidationError {
  /** 字段路径 (支持嵌套，如 'config.apiKey') */
  field: string
  /** 错误类型 */
  type: ValidationErrorType
  /** 错误消息 */
  message: string
  /** 实际值 */
  actual?: unknown
  /** 期望值或约束 */
  expected?: unknown
}

/**
 * 验证结果
 */
export interface ValidationResult {
  /** 是否验证通过 */
  valid: boolean
  /** 错误列表 */
  errors: ValidationError[]
}

/**
 * 字段验证规则
 */
export interface FieldRule<T = unknown> {
  /** 是否必填 */
  required?: boolean
  /** 类型检查 */
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array'
  /** 自定义验证函数 */
  validate?: (value: T) => boolean | string
  /** 最小值 */
  min?: number
  /** 最大值 */
  max?: number
  /** 最小长度 */
  minLength?: number
  /** 最大长度 */
  maxLength?: number
  /** 正则匹配 */
  pattern?: RegExp
  /** 枚举值 */
  enum?: unknown[]
  /** 默认值 */
  default?: T
  /** 字段描述 (用于错误消息) */
  description?: string
}

/**
 * 对象验证规则
 */
export type ObjectRules<T> = {
  [K in keyof T]?: FieldRule<T[K]>
}

/**
 * 创建验证结果
 */
function createResult(valid: boolean, errors: ValidationError[] = []): ValidationResult {
  return { valid, errors }
}

/**
 * 创建单个错误
 */
function createError(
  field: string,
  type: ValidationErrorType,
  message: string,
  actual?: unknown,
  expected?: unknown
): ValidationError {
  return { field, type, message, actual, expected }
}

/**
 * 合并多个验证结果
 */
export function mergeResults(...results: ValidationResult[]): ValidationResult {
  const allErrors = results.flatMap((r) => r.errors)
  return createResult(allErrors.length === 0, allErrors)
}

/**
 * 验证单个字段
 */
export function validateField<T>(
  fieldName: string,
  value: T | undefined,
  rule: FieldRule<T>
): ValidationResult {
  const errors: ValidationError[] = []

  // 必填检查
  if (rule.required && (value === undefined || value === null)) {
    errors.push(createError(
      fieldName,
      'required',
      `${rule.description || fieldName} is required`,
      value
    ))
    return createResult(false, errors)
  }

  // 值不存在且非必填，跳过其他检查
  if (value === undefined || value === null) {
    return createResult(true)
  }

  // 类型检查
  if (rule.type) {
    const actualType = Array.isArray(value) ? 'array' : typeof value
    if (actualType !== rule.type) {
      errors.push(createError(
        fieldName,
        'type_mismatch',
        `${rule.description || fieldName} must be of type ${rule.type}, got ${actualType}`,
        value,
        rule.type
      ))
      return createResult(false, errors)
    }
  }

  // 数值范围检查
  if (rule.type === 'number' && typeof value === 'number') {
    if (rule.min !== undefined && value < rule.min) {
      errors.push(createError(
        fieldName,
        'out_of_range',
        `${rule.description || fieldName} must be >= ${rule.min}, got ${value}`,
        value,
        `>= ${rule.min}`
      ))
    }
    if (rule.max !== undefined && value > rule.max) {
      errors.push(createError(
        fieldName,
        'out_of_range',
        `${rule.description || fieldName} must be <= ${rule.max}, got ${value}`,
        value,
        `<= ${rule.max}`
      ))
    }
  }

  // 长度检查
  if ((typeof value === 'string' || Array.isArray(value))) {
    const length = value.length
    if (rule.minLength !== undefined && length < rule.minLength) {
      errors.push(createError(
        fieldName,
        'out_of_range',
        `${rule.description || fieldName} length must be >= ${rule.minLength}, got ${length}`,
        length,
        `>= ${rule.minLength}`
      ))
    }
    if (rule.maxLength !== undefined && length > rule.maxLength) {
      errors.push(createError(
        fieldName,
        'out_of_range',
        `${rule.description || fieldName} length must be <= ${rule.maxLength}, got ${length}`,
        length,
        `<= ${rule.maxLength}`
      ))
    }
  }

  // 正则匹配
  if (rule.pattern && typeof value === 'string') {
    if (!rule.pattern.test(value)) {
      errors.push(createError(
        fieldName,
        'format_error',
        `${rule.description || fieldName} does not match expected format`,
        value,
        rule.pattern.toString()
      ))
    }
  }

  // 枚举值检查
  if (rule.enum && !rule.enum.includes(value)) {
    errors.push(createError(
      fieldName,
      'invalid_value',
      `${rule.description || fieldName} must be one of: ${rule.enum.join(', ')}`,
      value,
      rule.enum
    ))
  }

  // 自定义验证
  if (rule.validate) {
    const result = rule.validate(value)
    if (result !== true) {
      const message = typeof result === 'string' ? result : `Validation failed for ${fieldName}`
      errors.push(createError(
        fieldName,
        'custom',
        message,
        value
      ))
    }
  }

  return createResult(errors.length === 0, errors)
}

/**
 * 验证对象
 */
export function validateObject<T extends object>(
  obj: Partial<T>,
  rules: ObjectRules<T>
): ValidationResult {
  const results: ValidationResult[] = []

  for (const key in rules) {
    if (Object.prototype.hasOwnProperty.call(rules, key)) {
      const rule = rules[key] as FieldRule<unknown>
      const value = obj[key]
      results.push(validateField(String(key), value, rule))
    }
  }

  return mergeResults(...results)
}

/**
 * CLI Engine 配置验证规则
 */
export const CLI_ENGINE_CONFIG_RULES: ObjectRules<import('./base').CLIEngineConfig> = {
  executablePath: {
    type: 'string',
    description: 'CLI executable path',
  },
  model: {
    type: 'string',
    minLength: 1,
    description: 'Model name',
  },
  apiKey: {
    type: 'string',
    minLength: 1,
    description: 'API key',
  },
  apiBase: {
    type: 'string',
    pattern: /^https?:\/\/.+/,
    description: 'API base URL',
  },
  extraArgs: {
    type: 'array',
    description: 'Extra CLI arguments',
  },
}

/**
 * Claude Engine 配置验证规则
 */
export const CLAUDE_ENGINE_CONFIG_RULES: ObjectRules<import('../engines/claude-code/engine').ClaudeEngineConfig> = {
  claudePath: {
    type: 'string',
    description: 'Claude CLI path',
  },
  defaultWorkspaceDir: {
    type: 'string',
    description: 'Default workspace directory',
  },
}

/**
 * 配置验证器类
 *
 * 提供链式 API 进行配置验证
 */
export class ConfigValidator<T extends object> {
  private rules: ObjectRules<T> = {}
  private config: Partial<T>

  constructor(config: Partial<T>) {
    this.config = config
  }

  /**
   * 设置验证规则
   */
  withRules(rules: ObjectRules<T>): this {
    this.rules = rules
    return this
  }

  /**
   * 添加单个字段规则
   */
  field<K extends keyof T>(name: K, rule: FieldRule<T[K]>): this {
    this.rules[name] = rule
    return this
  }

  /**
   * 执行验证
   */
  validate(): ValidationResult {
    return validateObject(this.config, this.rules)
  }

  /**
   * 验证并抛出错误
   */
  validateOrThrow(): void {
    const result = this.validate()
    if (!result.valid) {
      const messages = result.errors.map((e) => `${e.field}: ${e.message}`)
      throw new Error(`Configuration validation failed:\n${messages.join('\n')}`)
    }
  }
}

/**
 * 创建配置验证器
 */
export function validateConfig<T extends object>(config: Partial<T>): ConfigValidator<T> {
  return new ConfigValidator(config)
}

/**
 * 快捷验证函数 - CLI Engine 配置
 */
export function validateCLIEngineConfig(
  config: Partial<import('./base').CLIEngineConfig>
): ValidationResult {
  return validateObject(config, CLI_ENGINE_CONFIG_RULES)
}

/**
 * 快捷验证函数 - Claude Engine 配置
 */
export function validateClaudeEngineConfig(
  config: Partial<import('../engines/claude-code/engine').ClaudeEngineConfig>
): ValidationResult {
  return validateObject(config, CLAUDE_ENGINE_CONFIG_RULES)
}
