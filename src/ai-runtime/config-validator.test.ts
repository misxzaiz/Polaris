/**
 * 配置验证器测试
 */

import { describe, it, expect } from 'vitest'
import {
  validateField,
  validateObject,
  validateConfig,
  mergeResults,
  validateCLIEngineConfig,
  CLI_ENGINE_CONFIG_RULES,
} from './config-validator'

describe('validateField', () => {
  describe('required', () => {
    it('should fail for undefined required field', () => {
      const result = validateField('test', undefined, { required: true })
      expect(result.valid).toBe(false)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].type).toBe('required')
    })

    it('should pass for defined required field', () => {
      const result = validateField('test', 'value', { required: true })
      expect(result.valid).toBe(true)
    })

    it('should pass for undefined optional field', () => {
      const result = validateField('test', undefined, { required: false })
      expect(result.valid).toBe(true)
    })
  })

  describe('type', () => {
    it('should fail for type mismatch', () => {
      const result = validateField('test', 'string', { type: 'number' })
      expect(result.valid).toBe(false)
      expect(result.errors[0].type).toBe('type_mismatch')
    })

    it('should pass for correct type', () => {
      const result = validateField('test', 42, { type: 'number' })
      expect(result.valid).toBe(true)
    })

    it('should detect array type', () => {
      const result = validateField('test', [1, 2, 3], { type: 'array' })
      expect(result.valid).toBe(true)
    })

    it('should fail array for non-array', () => {
      const result = validateField('test', 'not array', { type: 'array' })
      expect(result.valid).toBe(false)
      expect(result.errors[0].type).toBe('type_mismatch')
    })
  })

  describe('range (number)', () => {
    it('should fail for value below min', () => {
      const result = validateField('test', 5, { type: 'number', min: 10 })
      expect(result.valid).toBe(false)
      expect(result.errors[0].type).toBe('out_of_range')
    })

    it('should fail for value above max', () => {
      const result = validateField('test', 100, { type: 'number', max: 50 })
      expect(result.valid).toBe(false)
      expect(result.errors[0].type).toBe('out_of_range')
    })

    it('should pass for value within range', () => {
      const result = validateField('test', 25, { type: 'number', min: 10, max: 50 })
      expect(result.valid).toBe(true)
    })
  })

  describe('length (string/array)', () => {
    it('should fail for string shorter than minLength', () => {
      const result = validateField('test', 'ab', { type: 'string', minLength: 3 })
      expect(result.valid).toBe(false)
      expect(result.errors[0].type).toBe('out_of_range')
    })

    it('should fail for string longer than maxLength', () => {
      const result = validateField('test', 'toolongstring', { type: 'string', maxLength: 5 })
      expect(result.valid).toBe(false)
    })

    it('should pass for string within length range', () => {
      const result = validateField('test', 'hello', { type: 'string', minLength: 3, maxLength: 10 })
      expect(result.valid).toBe(true)
    })

    it('should work for arrays too', () => {
      const result = validateField('test', [1, 2], { type: 'array', minLength: 3 })
      expect(result.valid).toBe(false)
    })
  })

  describe('pattern', () => {
    it('should fail for non-matching pattern', () => {
      const result = validateField('test', 'not-url', {
        type: 'string',
        pattern: /^https?:\/\/.+/
      })
      expect(result.valid).toBe(false)
      expect(result.errors[0].type).toBe('format_error')
    })

    it('should pass for matching pattern', () => {
      const result = validateField('test', 'https://example.com', {
        type: 'string',
        pattern: /^https?:\/\/.+/
      })
      expect(result.valid).toBe(true)
    })
  })

  describe('enum', () => {
    it('should fail for value not in enum', () => {
      const result = validateField('test', 'invalid', {
        enum: ['valid1', 'valid2']
      })
      expect(result.valid).toBe(false)
      expect(result.errors[0].type).toBe('invalid_value')
    })

    it('should pass for value in enum', () => {
      const result = validateField('test', 'valid1', {
        enum: ['valid1', 'valid2']
      })
      expect(result.valid).toBe(true)
    })
  })

  describe('custom validate', () => {
    it('should fail when custom validate returns false', () => {
      const result = validateField('test', 'value', {
        validate: () => false
      })
      expect(result.valid).toBe(false)
      expect(result.errors[0].type).toBe('custom')
    })

    it('should fail with custom message', () => {
      const result = validateField('test', 'value', {
        validate: () => 'Custom error message'
      })
      expect(result.valid).toBe(false)
      expect(result.errors[0].message).toBe('Custom error message')
    })

    it('should pass when custom validate returns true', () => {
      const result = validateField('test', 'value', {
        validate: () => true
      })
      expect(result.valid).toBe(true)
    })
  })

  describe('description', () => {
    it('should use description in error message', () => {
      const result = validateField('test', undefined, {
        required: true,
        description: 'Test Field'
      })
      expect(result.errors[0].message).toContain('Test Field')
    })
  })
})

describe('validateObject', () => {
  it('should validate all fields', () => {
    const result = validateObject(
      { name: 'test', count: 5 },
      {
        name: { required: true, type: 'string' },
        count: { type: 'number', min: 1 }
      }
    )
    expect(result.valid).toBe(true)
  })

  it('should collect all errors', () => {
    const result = validateObject(
      { name: '', count: -1 },
      {
        name: { required: true, type: 'string', minLength: 1 },
        count: { type: 'number', min: 0 }
      }
    )
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('should return empty errors for empty rules', () => {
    const result = validateObject({ name: 'test' }, {})
    expect(result.valid).toBe(true)
  })
})

describe('mergeResults', () => {
  it('should merge multiple valid results', () => {
    const result = mergeResults(
      { valid: true, errors: [] },
      { valid: true, errors: [] }
    )
    expect(result.valid).toBe(true)
  })

  it('should collect errors from multiple results', () => {
    const result = mergeResults(
      { valid: false, errors: [{ field: 'a', type: 'required', message: 'A is required' }] },
      { valid: false, errors: [{ field: 'b', type: 'required', message: 'B is required' }] }
    )
    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(2)
  })

  it('should handle mixed results', () => {
    const result = mergeResults(
      { valid: true, errors: [] },
      { valid: false, errors: [{ field: 'a', type: 'required', message: 'A is required' }] }
    )
    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(1)
  })
})

describe('ConfigValidator', () => {
  it('should provide fluent API', () => {
    const result = validateConfig({ name: 'test', count: 5 })
      .field('name', { required: true, type: 'string' })
      .field('count', { type: 'number', min: 1 })
      .validate()

    expect(result.valid).toBe(true)
  })

  it('should support withRules', () => {
    const result = validateConfig({ name: 'test' })
      .withRules({
        name: { required: true, type: 'string' }
      })
      .validate()

    expect(result.valid).toBe(true)
  })

  it('should throw on validateOrThrow', () => {
    expect(() => {
      validateConfig({ name: '' })
        .field('name', { required: true, minLength: 1 })
        .validateOrThrow()
    }).toThrow('Configuration validation failed')
  })
})

describe('validateCLIEngineConfig', () => {
  it('should validate valid config', () => {
    const result = validateCLIEngineConfig({
      executablePath: '/usr/local/bin/iflow',
      model: 'gpt-4',
      apiKey: 'sk-test',
      apiBase: 'https://api.example.com/v1',
    })
    expect(result.valid).toBe(true)
  })

  it('should pass for empty config (all optional)', () => {
    const result = validateCLIEngineConfig({})
    expect(result.valid).toBe(true)
  })

  it('should fail for invalid apiBase format', () => {
    const result = validateCLIEngineConfig({
      apiBase: 'not-a-url'
    })
    expect(result.valid).toBe(false)
    expect(result.errors[0].field).toBe('apiBase')
  })
})
