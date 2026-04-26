/**
 * 角色展示组件（大尺寸，用于 EmptyState 欢迎页）
 */

import { memo, useEffect } from 'react'
import { PolarisCharacter } from './PolarisCharacter'
import { useCharacterStore } from '../../stores/characterStore'

export const CharacterShowcase = memo(function CharacterShowcase() {
  const expression = useCharacterStore((s) => s.expression)
  const init = useCharacterStore((s) => s.init)

  // 确保 store 已初始化 EventBus 订阅
  useEffect(() => {
    const cleanup = init()
    return cleanup
  }, [init])

  return (
    <div className={`polaris-character polaris-character-showcase polaris-character-enter expression-${expression} mb-6`}>
      <PolarisCharacter expression={expression} size={120} />
    </div>
  )
})
