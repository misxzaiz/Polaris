#!/usr/bin/env node
/**
 * Agency Agents corpus 打包与 catalog 生成脚本(P0-1 / P0-4)。
 *
 * 一次性离线执行,产物入库;运行时(Rust agent_corpus.rs)只消费产物。
 *
 * 用法:
 *   node scripts/gen-agent-catalog.mjs --zh <agency-agents-zh 克隆路径> --en <agency-agents 克隆路径>
 *
 * 产物(写入 src-tauri/resources/agents/):
 *   corpus/<stem>.md      扁平化 agent 定义(保留原始 stem,即 roster slug;division 记入 catalog)
 *   divisions.json        zh 实际部门 ∪ en 元数据(label/icon/color;zh 新增部门补默认值)
 *   rosters.json          en strategy/runbooks.json 转换 + slug 存在性校验(缺失项记入 missing)
 *   roster_manifest.json  roster slug → 存在性/来源文件
 *   agent-roles.json      slug → developer|qa|gate-keeper|orchestrator|governance
 *   corpus-manifest.json  基线 commit / 计数 / 生成时间
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const zhRoot = arg('zh');
const enRoot = arg('en');
if (!zhRoot || !enRoot) {
  console.error('用法: node scripts/gen-agent-catalog.mjs --zh <path> --en <path>');
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = path.join(repoRoot, 'src-tauri', 'resources', 'agents');
const corpusDir = path.join(outRoot, 'corpus');

// 非 division 目录(对齐上游 check-divisions.sh 的 NON_DIVISION_DIRS)
const NON_DIVISION = new Set(['integrations', 'strategy', 'examples', 'scripts', 'assets', '.github', 'node_modules']);

function gitHead(dir) {
  try {
    return execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
  } catch {
    return 'unknown';
  }
}

function listAgentFiles(root) {
  const out = [];
  for (const div of fs.readdirSync(root)) {
    const divPath = path.join(root, div);
    if (!fs.statSync(divPath).isDirectory() || NON_DIVISION.has(div) || div.startsWith('.')) continue;
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) {
          walk(p);
        } else if (name.endsWith('.md') && name !== 'README.md') {
          out.push({ division: div, file: p, stem: name.slice(0, -3) });
        }
      }
    };
    walk(divPath);
  }
  return out;
}

function parseFrontmatter(content) {
  const fm = {};
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return fm;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l === '---') break;
    const m = l.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return fm;
}

// ---- 1. 收集 zh corpus(主体),扁平化保留原始 stem ----
const files = listAgentFiles(zhRoot);
const byStem = new Map();
for (const f of files) {
  if (byStem.has(f.stem)) {
    console.error(`stem 冲突: ${f.stem} (${f.file} vs ${byStem.get(f.stem).file})`);
    process.exit(1);
  }
  byStem.set(f.stem, f);
}

fs.rmSync(corpusDir, { recursive: true, force: true });
fs.mkdirSync(corpusDir, { recursive: true });
const catalog = [];
for (const f of byStem.values()) {
  const content = fs.readFileSync(f.file, 'utf8');
  const fm = parseFrontmatter(content);
  if (!fm.name) {
    console.error(`缺 frontmatter name,跳过: ${f.file}`);
    continue;
  }
  fs.writeFileSync(path.join(corpusDir, `${f.stem}.md`), content);
  catalog.push({ slug: f.stem, name: fm.name, description: fm.description ?? '', emoji: fm.emoji ?? '', color: fm.color ?? '', division: f.division });
}
catalog.sort((a, b) => a.slug.localeCompare(b.slug));

// ---- 2. divisions.json:zh 实际目录 ∪ en 元数据 ----
const enDivisions = JSON.parse(fs.readFileSync(path.join(enRoot, 'divisions.json'), 'utf8')).divisions;
const ZH_EXTRA = {
  hr: { label: '人力资源', icon: 'Users', color: '#F472B6' },
  legal: { label: '法务', icon: 'Scale', color: '#94A3B8' },
  'supply-chain': { label: '供应链', icon: 'Truck', color: '#FB923C' },
};
const divisions = {};
for (const div of new Set(catalog.map((c) => c.division))) {
  divisions[div] = enDivisions[div] ?? ZH_EXTRA[div] ?? { label: div, icon: 'Folder', color: '#8B949E' };
}

// ---- 3. rosters.json + roster_manifest.json(slug 存在性校验) ----
// 上游→zh 已知路径映射(integration-plan 附录 A.2)
const SLUG_ALIAS = {
  'customer-service': 'support-support-responder',
  'sales-outreach': 'sales-outbound-strategist',
  'marketing-bilibili-content-strategist': 'marketing-bilibili-strategist',
};
const runbooks = JSON.parse(fs.readFileSync(path.join(enRoot, 'strategy', 'runbooks.json'), 'utf8')).runbooks;
const manifest = [];
const rosters = runbooks.map((rb) => ({
  slug: rb.slug,
  title: rb.title,
  mode: rb.mode,
  duration: rb.duration,
  summary: rb.summary,
  groups: rb.roster.map((g) => ({
    group: g.group,
    activation: g.activation,
    members: g.agents.map((slug) => {
      const resolved = byStem.has(slug) ? slug : SLUG_ALIAS[slug];
      const exists = !!(resolved && byStem.has(resolved));
      manifest.push({ runbook: rb.slug, slug, resolved: resolved ?? null, exists });
      return resolved ?? slug;
    }),
  })),
}));
const missing = manifest.filter((m) => !m.exists);

// ---- 4. agent-roles.json(启发式分类,可人工修订) ----
const ROLE_RULES = [
  { role: 'orchestrator', test: (c) => /orchestrator/.test(c.slug) },
  { role: 'gate-keeper', test: (c) => /reality-checker|evidence-collector|studio-producer|executive-summary/.test(c.slug) },
  { role: 'qa', test: (c) => c.division === 'testing' || /-tester|qa-/.test(c.slug) },
  { role: 'governance', test: (c) => ['legal', 'security', 'finance', 'hr'].includes(c.division) || /compliance|audit/.test(c.slug) },
];
const roles = {};
for (const c of catalog) {
  roles[c.slug] = ROLE_RULES.find((r) => r.test(c))?.role ?? 'developer';
}

// ---- 5. agent-index.md(P1-1,L2 语义路由索引)+ activation 模板(P1-2) ----
const indexLines = catalog.map((c) => `- ${c.slug} — ${c.name} — ${c.description}`);
fs.writeFileSync(
  path.join(outRoot, 'agent-index.md'),
  `# Agent Index\n\n> ${catalog.length} 位专家的语义路由索引(slug — 显示名 — 职责)。按任务语义匹配后,用 slug 经 dispatch_agent/dispatch_task 派发。\n\n${indexLines.join('\n')}\n`,
);

// activation 模板:zh strategy/coordination/agent-activation-prompts.md 按 `### 中文名` 分节,
// 经 catalog name→slug 映射落 activation/<slug>.md;未覆盖的 agent 用 _generic.md 回退。
const activationDir = path.join(outRoot, 'activation');
fs.rmSync(activationDir, { recursive: true, force: true });
fs.mkdirSync(activationDir, { recursive: true });
const nameToSlug = new Map(catalog.map((c) => [c.name, c.slug]));
// activation 标题与 catalog 显示名的已知别名(上游文档与 corpus 命名漂移)
nameToSlug.set('高管摘要生成器', 'support-executive-summary-generator');
const actSrc = path.join(zhRoot, 'strategy', 'coordination', 'agent-activation-prompts.md');
let actCovered = 0;
let actUnmatched = [];
if (fs.existsSync(actSrc)) {
  const sections = fs.readFileSync(actSrc, 'utf8').split(/^### /m).slice(1);
  for (const sec of sections) {
    const nl = sec.indexOf('\n');
    // 标题形如 "前端开发者" 或 "智能体编排者 — 完整流水线"(取 — 前主名)
    const heading = sec.slice(0, nl).trim();
    const mainName = heading.split('—')[0].trim();
    const body = sec.slice(nl + 1).trim();
    const slug = nameToSlug.get(mainName);
    if (!slug) {
      actUnmatched.push(heading);
      continue;
    }
    // 同一 agent 多变体(如编排者)追加到同一文件
    const file = path.join(activationDir, `${slug}.md`);
    const chunk = `## ${heading}\n\n${body}\n\n`;
    if (fs.existsSync(file)) {
      fs.appendFileSync(file, chunk);
    } else {
      fs.writeFileSync(file, chunk);
      actCovered++;
    }
  }
}
fs.writeFileSync(
  path.join(activationDir, '_generic.md'),
  `## 通用激活模板

\`\`\`
你是 [AGENT_NAME],在 [PROJECT] 的 NEXUS 流水线中工作。

阶段:[PHASE]
任务:[TASK ID] — [TASK]
验收标准:[ACCEPTANCE CRITERIA]

参考文档:[REFERENCE DOCUMENTS]

要求:
- 只做任务描述与验收标准内的事,不额外加功能
- 交付时逐条对照验收标准给出证据
- 完成后你的工作将由 [REVIEWER] 验证
\`\`\`
`,
);

// ---- 6. 写产物 ----
const write = (name, data) => fs.writeFileSync(path.join(outRoot, name), JSON.stringify(data, null, 2) + '\n');
write('catalog.json', { agents: catalog });
write('divisions.json', { divisions });
write('rosters.json', { rosters });
write('roster_manifest.json', { entries: manifest, missing: missing.map((m) => m.slug) });
write('agent-roles.json', { roles });
write('corpus-manifest.json', {
  generatedBy: 'scripts/gen-agent-catalog.mjs',
  sources: {
    'agency-agents-zh': { commit: gitHead(zhRoot), agentCount: catalog.length },
    'agency-agents': { commit: gitHead(enRoot), use: 'divisions.json + strategy/runbooks.json 元数据' },
  },
  corpusVersion: 1,
});

console.log(`corpus: ${catalog.length} agents → ${corpusDir}`);
console.log(`agent-index: ${indexLines.length} 行; activation 模板覆盖 ${actCovered} 个 agent,未匹配标题 ${actUnmatched.length}${actUnmatched.length ? ' → ' + actUnmatched.join(' / ') : ''}`);
console.log(`divisions: ${Object.keys(divisions).length}`);
console.log(`rosters: ${rosters.length}, roster 成员 ${manifest.length}, 未解析 slug ${missing.length}${missing.length ? ' → ' + [...new Set(missing.map((m) => m.slug))].join(', ') : ''}`);
const roleCount = Object.values(roles).reduce((acc, r) => ((acc[r] = (acc[r] ?? 0) + 1), acc), {});
console.log(`roles: ${JSON.stringify(roleCount)}`);
if (missing.length) process.exitCode = 2;
