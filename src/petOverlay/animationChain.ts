/**
 * 随机链骰子（机械拆分自 OverlayApp.tsx）。
 * 纯函数，零副作用，可单测。
 * 规格：plans/pet-overlay-r2-spec.md §3.2 / §4.1
 */
import { IDLE, TURN, IDLE_WEIGHT, TURN_WEIGHT, MOVE_WEIGHT, CATEGORIES } from './constants'

/** 从数组随机取一个，可避免取到指定值（原版 pick 语义）。 */
export function pick<T>(arr: T[], avoid?: T): T {
  if (arr.length === 1) return arr[0]
  const pool = avoid ? arr.filter((x) => x !== avoid) : arr
  return (pool.length ? pool : arr)[Math.floor(Math.random() * (pool.length || arr.length))]
}

export interface ChainRoll {
  anim: string
  once: boolean   // true = 一次性动作（播完回链），false = 循环段（idle/turn）
  move: boolean   // true = 转走位
}

/**
 * 随机链骰子（同步面板版 rollNext；move 权重命中由调用方转走位）。
 * 权重区：IDLE / TURN / MOVE / CATEGORIES 各类（小动作/玩耍/吃什么/时节/文字）。
 */
export function rollChain(current: string): ChainRoll {
  const totalCat = CATEGORIES.reduce((s, c) => s + c.weight, 0)
  const r = Math.random() * (IDLE_WEIGHT + TURN_WEIGHT + MOVE_WEIGHT + totalCat)
  let acc = 0
  if (r < (acc += IDLE_WEIGHT)) return { anim: pick(IDLE, current), once: false, move: false }
  if (r < (acc += TURN_WEIGHT)) return { anim: pick(TURN, current), once: false, move: false }
  if (r < (acc += MOVE_WEIGHT)) return { anim: '', once: false, move: true }
  const catR = Math.random() * totalCat
  let cAcc = 0
  for (const c of CATEGORIES) {
    cAcc += c.weight
    if (catR < cAcc) return { anim: pick(c.actions, current), once: true, move: false }
  }
  return { anim: pick(IDLE, current), once: false, move: false }
}
