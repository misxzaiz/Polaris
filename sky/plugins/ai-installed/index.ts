import type { Capability } from '../../src/contracts.ts';
import type { Router } from '../../src/server/router.ts';

const greetCap: Capability = {
  id: 'cap.greet',
  description: 'Greeting cap installed by AI. Returns a greeting.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Name to greet' } },
  },
  async invoke(params) {
    const p = (params ?? {}) as { name?: string };
    return { greeting: `Hello, ${p.name || 'world'}! Installed by AI.` };
  },
};

export default function setup(router: Router) {
  router.register(greetCap);
}

export async function teardown(router: Router) {
  router.unregister('cap.greet');
}
