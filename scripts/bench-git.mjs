/**
 * bench-git.mjs — git 面板性能预算实测（master-plan §十一 欠账 ⑩）
 *
 * 实测对象：真实生产链路 polaris-web → RouterBus → cap.git → GitService(git2)。
 * bench 构建形态（如实标注）：polaris-web 独立 bin 需带 git feature：
 *   cargo build --no-default-features --features git --bin polaris-web
 *   （标准 web-gate 形态 --no-default-features 不含 git → cap.git 未注册，测不了）
 * 数据根隔离：POLARIS_DATA_ROOT=<dir> POLARIS_WEB_PORT=9830 polaris-web.exe
 *
 * 场景（对齐 master-plan §预算表）：
 *   1. log 首页（get_log_with_lanes limit=100, skip=0）  预算 p95 < 200ms
 *   2. log 翻页（limit=100, skip=100）                   预算 p95 < 200ms
 *   3. log 深翻页（limit=100, skip=500）                 预算 p95 < 200ms
 *   4. 热开（同 action 连续重复调用，进程热后）          预算 p50 < 50ms
 *
 * 用法：
 *   node scripts/bench-git.mjs [--base http://127.0.0.1:9830] [--repo <path>]
 *                              [--samples 30] [--out <file.json>]
 *   服务不可达 → 直接失败退出（不产任何 mock 数字）。
 */

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const BASE = argOf('--base', 'http://127.0.0.1:9830')
const REPO = argOf('--repo', 'D:\\space\\base\\Polaris')
const SAMPLES = Number(argOf('--samples', '30'))
const OUT = argOf('--out', null)

/** 单次 HTTP → RouterBus → cap.git 调用计时（ms），返回 {ms, rows} */
async function timeCall(action, params) {
  const t0 = performance.now()
  const res = await fetch(`${BASE}/api/router_dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ req: { target: 'cap.git', payload: { action, ...params } } }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  const body = await res.json()
  if (!body.ok) throw new Error(`cap error: ${JSON.stringify(body.error)}`)
  const rows = body.result?.commits?.length ?? body.result?.rows?.length ?? -1
  return { ms: performance.now() - t0, rows }
}

function pctl(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}
function summarize(samples) {
  const s = [...samples].sort((a, b) => a - b)
  return { n: s.length, p50: +pctl(s, 50).toFixed(1), p95: +pctl(s, 95).toFixed(1), max: +s[s.length - 1].toFixed(1) }
}

async function main() {
  // 可达性预检（fail-fast）
  try {
    await timeCall('get_status', { workspacePath: REPO })
  } catch (e) {
    console.error(`bench 前置失败：${BASE} 不可用或 cap.git 未注册\n  ${e.message}`)
    console.error('  先构建带 git feature 的 polaris-web 并启动：')
    console.error('    cargo build --no-default-features --features git --bin polaris-web')
    console.error('    POLARIS_DATA_ROOT=<dir> POLARIS_WEB_PORT=9830 polaris-web.exe')
    process.exit(1)
  }

  const results = []

  /** 跑一个场景：1 次 cold（单列）+ SAMPLES 次热样本 */
  async function scenario(name, action, params) {
    const cold = await timeCall(action, params)
    const samples = []
    for (let i = 0; i < SAMPLES; i++) {
      samples.push((await timeCall(action, params)).ms)
    }
    const s = summarize(samples)
    const row = { name, action, params, cold_ms: +cold.ms.toFixed(1), rows: cold.rows, ...s }
    results.push(row)
    console.log(
      `${name.padEnd(46)} cold=${row.cold_ms}ms  p50=${s.p50}ms  p95=${s.p95}ms  max=${s.max}ms  (n=${s.n}, rows=${row.rows})`,
    )
    return row
  }

  await scenario('log 首页 limit=100', 'get_log_with_lanes', { workspacePath: REPO, limit: 100, skip: 0 })
  await scenario('log 翻页 limit=100 skip=100', 'get_log_with_lanes', { workspacePath: REPO, limit: 100, skip: 100 })
  await scenario('log 深翻页 limit=100 skip=500', 'get_log_with_lanes', { workspacePath: REPO, limit: 100, skip: 500 })
  await scenario('热开 status', 'get_status', { workspacePath: REPO })
  await scenario('热开 log 首页（重复）', 'get_log_with_lanes', { workspacePath: REPO, limit: 100, skip: 0 })

  console.log('\n预算对照（master-plan §预算表）：log 翻页 p95<200ms；热开 p50<50ms')
  const page = results.find((r) => r.name.includes('翻页'))
  const hot = results.find((r) => r.name.includes('热开 log'))
  console.log(`  log 翻页 p95=${page?.p95}ms（预算 200）→ ${page && page.p95 < 200 ? '达标' : '超标'}`)
  console.log(`  热开 p50=${hot?.p50}ms（预算 50）→ ${hot && hot.p50 < 50 ? '达标' : '超标'}`)

  if (OUT) {
    const report = {
      meta: { base: BASE, repo: REPO, samples: SAMPLES, date: new Date().toISOString(), build: 'polaris-web --no-default-features --features git (debug)' },
      results,
    }
    const { writeFileSync } = await import('node:fs')
    writeFileSync(OUT, JSON.stringify(report, null, 2))
    console.log(`\n报告已写：${OUT}`)
  }
}

main().catch((e) => {
  console.error(`bench 失败：${e.message}`)
  process.exit(1)
})
