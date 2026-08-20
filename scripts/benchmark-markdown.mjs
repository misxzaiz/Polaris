/**
 * Markdown Parsing Performance Benchmark
 *
 * Measures the cost of marked.parse(), string.split(), and regex matching
 * across a range of realistic chat-message sizes.
 *
 * Usage:  node scripts/benchmark-markdown.mjs
 */

import { marked } from 'marked';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function padRight(str, len) {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

function padLeft(str, len) {
  return str.length >= len ? str : ' '.repeat(len - str.length) + str;
}

function formatNs(ns) {
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(2)} ms`;
  if (ns >= 1_000) return `${(ns / 1_000).toFixed(2)} us`;
  return `${ns.toFixed(0)} ns`;
}

function hrToNs(hr) {
  return hr[0] * 1e9 + hr[1];
}

// ---------------------------------------------------------------------------
// Test-content generators
// ---------------------------------------------------------------------------

/** Short paragraph (~100 chars) */
function makeShort() {
  return `This is a **short** paragraph with some *italic* text and \`inline code\` for testing.`;
}

/** Medium paragraph (~500 chars) */
function makeMedium() {
  return [
    '## Overview\n\n',
    'The **quick** brown fox jumps over the *lazy* dog. This paragraph contains ',
    '`inline code` and a [link](https://example.com) for good measure.\n\n',
    '- First item with **bold**\n',
    '- Second item with *italic*\n',
    '- Third item with `code`\n\n',
    '> A blockquote that spans a couple of words.\n',
  ].join('');
}

/** Long paragraph with list, bold, code (~2000 chars) */
function makeLong() {
  return [
    '# Performance Report\n\n',
    '## Summary\n\n',
    'The system processed **12,847** requests in the last *24 hours* with an average ',
    'latency of `42ms`. Peak throughput reached **2,400 req/s** during the evening rush.\n\n',
    '### Key Metrics\n\n',
    '| Metric       | Value    | Status    |\n',
    '|--------------|----------|-----------|\n',
    '| Latency P50  | `28ms`   | OK        |\n',
    '| Latency P99  | `190ms`  | Warning   |\n',
    '| Error Rate   | `0.03%`  | OK        |\n',
    '| Throughput   | 2,400/s  | OK        |\n\n',
    '### Observations\n\n',
    '1. **CPU usage** remained under *60%* throughout the test window.\n',
    '2. Memory grew steadily from `120MB` to `185MB` before GC reclaimed space.\n',
    '3. The `processQueue()` function accounted for **38%** of total cycle time.\n\n',
    '> Note: All measurements taken on a *single-node* staging cluster.\n\n',
    'Here is a small code sample:\n\n',
    '```js\n',
    'function throttle(fn, ms) {\n',
    '  let last = 0;\n',
    '  return (...args) => {\n',
    '    const now = Date.now();\n',
    '    if (now - last >= ms) {\n',
    '      last = now;\n',
    '      return fn(...args);\n',
    '    }\n',
    '  };\n',
    '}\n',
    '```\n',
  ].join('');
}

/** Multiple paragraphs (~5000 chars) */
function makeMultiPara() {
  const base = makeLong();
  const extra = [
    '\n## Additional Analysis\n\n',
    '### Thread Pool\n\n',
    'The worker pool maintained **8 threads** during the benchmark. Each thread ',
    'processes requests from a shared `ConcurrentQueue<T>` instance with a ',
    '*lock-free* dequeue implementation.\n\n',
    '```typescript\n',
    'class ConcurrentQueue<T> {\n',
    '  private head: AtomicRef<Node<T>>;\n',
    '  private tail: AtomicRef<Node<T>>;\n\n',
    '  enqueue(value: T): void {\n',
    '    const node = new Node(value);\n',
    '    let tail = this.tail.load();\n',
    '    while (!this.tail.compareExchange(tail, node)) {\n',
    '      tail = this.tail.load();\n',
    '    }\n',
    '    tail.next = node;\n',
    '  }\n',
    '}\n',
    '```\n\n',
    '### Network I/O\n\n',
    '| Direction | Bytes      | Packets  |\n',
    '|-----------|------------|----------|\n',
    '| Inbound   | 4.2 GB     | 3.1M     |\n',
    '| Outbound  | 8.7 GB     | 6.4M     |\n\n',
    '- **TCP retransmits**: 0.01%\n',
    '- **Connection errors**: *negligible*\n',
    '- **TLS handshake**: `12ms` average\n\n',
    '> The network layer showed no signs of saturation.\n',
  ].join('');
  return base + extra;
}

/** Long message with code blocks (~10000 chars) */
function makeLongWithCode() {
  const base = makeMultiPara();
  const extra = [
    '\n## Deep Dive: Rendering Pipeline\n\n',
    'The rendering pipeline consists of **four stages**: parse, transform, layout, ',
    'and paint. Each stage operates on a *virtual DOM tree* that is diffed against ',
    'the previous frame before committing changes to the browser.\n\n',
    '### Stage 1 - Parse\n\n',
    '```rust\n',
    'pub fn parse(source: &str) -> Ast {\n',
    '    let tokens = Lexer::new(source).tokenize();\n',
    '    let mut parser = Parser::new(tokens);\n',
    '    parser.build_ast()\n',
    '}\n',
    '```\n\n',
    'The lexer produces a flat list of `Token` variants which the parser then ',
    'assembles into a hierarchical `Ast` (Abstract Syntax Tree).\n\n',
    '### Stage 2 - Transform\n\n',
    '```python\n',
    'def transform(ast: Node) -> Node:\n',
    '    """Apply optimisation passes to the AST."""\n',
    '    ast = fold_constants(ast)\n',
    '    ast = eliminate_dead_code(ast)\n',
    '    ast = inline_small_functions(ast)\n',
    '    return ast\n',
    '```\n\n',
    '### Stage 3 - Layout\n\n',
    'Layout computes the *bounding boxes* for every node:\n\n',
    '```go\n',
    'func Layout(root *Node) {\n',
    '    stack := []*Node{root}\n',
    '    for len(stack) > 0 {\n',
    '        n := stack[len(stack)-1]\n',
    '        stack = stack[:len(stack)-1]\n',
    '        n.Box = computeBox(n)\n',
    '        stack = append(stack, n.Children...)\n',
    '    }\n',
    '}\n',
    '```\n\n',
    '### Stage 4 - Paint\n\n',
    '```cpp\n',
    'void paint(const Node& root, Canvas& canvas) {\n',
    '    for (auto& child : root.children()) {\n',
    '        canvas.drawRect(child.box(), child.style());\n',
    '        if (child.isText()) {\n',
    '            canvas.drawText(child.text(), child.font());\n',
    '        }\n',
    '        paint(child, canvas);\n',
    '    }\n',
    '}\n',
    '```\n\n',
    '### Performance Numbers\n\n',
    '| Stage     | Avg Time | P99 Time |\n',
    '|-----------|----------|----------|\n',
    '| Parse     | 0.8ms    | 1.2ms    |\n',
    '| Transform | 0.3ms    | 0.5ms    |\n',
    '| Layout    | 1.4ms    | 2.1ms    |\n',
    '| Paint     | 3.2ms    | 4.8ms    |\n\n',
    '**Total frame budget**: *16.6ms* at 60fps. The pipeline comfortably fits ',
    'within budget at `5.7ms` average.\n\n',
    '> Conclusion: No rendering bottlenecks detected in this profiling session.\n',
  ].join('');
  return base + extra;
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

const ITERATIONS = 100;
const CODE_BLOCK_RE = /```/g;

/**
 * @param {string} label
 * @param {string} content
 * @param {number} iterations
 */
function runBenchmark(label, content, iterations) {
  const charCount = content.length;

  // --- Warm-up (1 iteration, discard result) ---
  marked.parse(content);
  content.split('\n\n');
  content.match(CODE_BLOCK_RE);

  // --- 1. marked.parse() ---
  let parseTotal = 0;
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime();
    marked.parse(content);
    parseTotal += hrToNs(process.hrtime(start));
  }

  // --- 2. String split by \n\n ---
  let splitTotal = 0;
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime();
    content.split('\n\n');
    splitTotal += hrToNs(process.hrtime(start));
  }

  // --- 3. Regex /```/g match ---
  let regexTotal = 0;
  for (let i = 0; i < iterations; i++) {
    CODE_BLOCK_RE.lastIndex = 0;
    const start = process.hrtime();
    content.match(CODE_BLOCK_RE);
    regexTotal += hrToNs(process.hrtime(start));
  }

  return {
    label,
    chars: charCount,
    parseAvg: parseTotal / iterations,
    parseTotal,
    splitAvg: splitTotal / iterations,
    splitTotal,
    regexAvg: regexTotal / iterations,
    regexTotal,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const testCases = [
  { label: 'Short (~100 chars)',    gen: makeShort         },
  { label: 'Medium (~500 chars)',   gen: makeMedium        },
  { label: 'Long (~2000 chars)',    gen: makeLong          },
  { label: 'Multi-para (~5000)',    gen: makeMultiPara     },
  { label: 'Long+Code (~10000)',    gen: makeLongWithCode  },
];

console.log('Markdown Parsing Performance Benchmark');
console.log(`Iterations per test: ${ITERATIONS}`);
console.log(`Node ${process.version} | marked from node_modules\n`);

const results = testCases.map(({ label, gen }) =>
  runBenchmark(label, gen(), ITERATIONS),
);

// Print table header
const col = [
  padRight('Content', 24),
  padLeft('Chars', 7),
  padLeft('marked.parse', 16),
  padLeft('split(\\n\\n)', 14),
  padLeft('regex /```/g', 14),
  padLeft('parse/split', 14),
].join('  |  ');

console.log(col);
console.log('-'.repeat(col.length));

for (const r of results) {
  const ratio = r.parseAvg / r.splitAvg;
  const row = [
    padRight(r.label, 24),
    padLeft(String(r.chars), 7),
    padLeft(formatNs(r.parseAvg), 16),
    padLeft(formatNs(r.splitAvg), 14),
    padLeft(formatNs(r.regexAvg), 14),
    padLeft(`${ratio.toFixed(1)}x`, 14),
  ].join('  |  ');
  console.log(row);
}

console.log('\nAll values are averages over', ITERATIONS, 'iterations.');
console.log('parse/split ratio shows how many times slower marked.parse() is vs a simple string split.');
