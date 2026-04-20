/**
 * 角色头像组件（小尺寸，用于聊天气泡）
 */

import { memo, useEffect } from 'react'
import { PolarisCharacter } from './PolarisCharacter'
import { useCharacterStore } from '../../stores/characterStore'

export const CharacterAvatar = memo(function CharacterAvatar() {
  const expression = useCharacterStore((s) => s.expression)
  const init = useCharacterStore((s) => s.init)

  // 确保 store 已初始化 EventBus 订阅
  useEffect(() => {
    const cleanup = init()
    return cleanup
  }, [init])

  return (
    <div className="shrink-0 mt-0.5">
      <div className={`polaris-character polaris-character-avatar expression-${expression}`}>
        <PolarisCharacter expression={expression} size={20} />
      </div>
    </div>
  )
})
