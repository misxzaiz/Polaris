// 验证 AI SSE 解析 + 工具调用循环(用 mock SSE server)
// 第一轮: 文本 + 工具调用 cap.echo
// 第二轮: 纯文本收尾(模拟 AI 看到工具结果后给最终答复)
import { createServer } from 'node:http';
import { EventBus } from '../src/server/eventbus.ts';
import { Router } from '../src/server/router.ts';
import { DefaultPermission } from '../src/contracts.ts';
import { createAiChatCap } from '../src/caps/ai.ts';
import { echoCap } from '../src/caps/echo.ts';
import { kvCap } from '../src/caps/kv.ts';
import { configCap } from '../src/caps/config.ts';

let round = 0;
const roundResponses = [
  // round 0: 工具调用
  [
    'data: {"choices":[{"delta":{"content":"Let me check "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"the env."}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"cap.echo","arguments":"{\\"message\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"hi\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ],
  // round 1: 最终文本
  [
    'data: {"choices":[{"delta":{"content":"Echo returned: hi. Done."}}]}\n\n',
    'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ],
];

const mock = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const responses = roundResponses[round++] || roundResponses[roundResponses.length - 1];
  let i = 0;
  const interval = setInterval(() => {
    if (i < responses.length) { res.write(responses[i]); i++; }
    else { res.end(); clearInterval(interval); }
  }, 40);
});

mock.listen(0, async () => {
  const port = mock.address().port;
  console.log('mock AI on', port);

  const bus = new EventBus();
  const router = new Router(new DefaultPermission(['cap.echo','cap.kv','cap.config','cap.ai.chat']), bus);
  router.register(echoCap);
  router.register(kvCap);
  router.register(configCap);
  router.register(createAiChatCap(router));

  await router.dispatch('cap.config', { action: 'set', value: {
    ai: { baseUrl: `http://localhost:${port}`, apiKey: 'mock', model: 'gpt-4o-mini', maxTokens: 100 },
  } }, { kind: 'bootstrap' });

  const events: any[] = [];
  bus.subscribe('test', e => events.push(e));

  const reply = await router.dispatchStream('cap.ai.chat', {
    messages: [{ role: 'user', content: 'echo hi via tool' }],
  }, { kind: 'bootstrap' });

  const streamId = reply.result.ok ? reply.result.data.streamId : null;
  console.log('streamId:', streamId);

  await new Promise(r => setTimeout(r, 1200));

  const chunks = events.filter(e => e.type === 'stream.chunk').map(e => e.data).join('');
  const tools = events.filter(e => e.type === 'stream.tool').map(e => e.data);
  const toolResults = events.filter(e => e.type === 'stream.toolResult').map(e => e.data);
  const end = events.find(e => e.type === 'stream.end');

  console.log('chunks:', JSON.stringify(chunks));
  console.log('tool calls:', JSON.stringify(tools, null, 2));
  console.log('tool results:', JSON.stringify(toolResults, null, 2));
  console.log('end:', JSON.stringify(end?.data));

  mock.close();
  const pass = end?.data?.ok === true
    && chunks.includes('Let me check the env.')
    && chunks.includes('Echo returned: hi. Done.')
    && tools.length === 1 && tools[0].name === 'cap.echo'
    && toolResults.length === 1 && toolResults[0].result?.ok === true;
  console.log('\nVERDICT:', pass ? 'PASS ✅' : 'FAIL ❌');
  process.exit(pass ? 0 : 1);
});
