import type { Capability } from '../../src/contracts.ts';
import type { Router } from '../../src/server/router.ts';

const colorCap: Capability = {
  id: 'cap.color',
  description: 'Generate a random hex color or convert formats. Actions: random/convert.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['random', 'convert'] },
      color: { type: 'string', description: 'Color to convert (hex/rgb), e.g. #ff0000 or rgb(255,0,0)' },
      to: { type: 'string', enum: ['hex', 'rgb'], description: 'Target format for convert' },
    },
    required: ['action'],
  },
  async invoke(params) {
    const p = (params ?? {}) as { action: string; color?: string; to?: string };
    if (p.action === 'random') {
      const hex = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6,'0');
      const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
      return { hex, rgb: `rgb(${r},${g},${b})`, r, g, b };
    }
    if (p.action === 'convert' && p.color) {
      // 简化: hex→rgb 或 rgb→hex
      if (p.color.startsWith('#')) {
        const r = parseInt(p.color.slice(1,3),16), g = parseInt(p.color.slice(3,5),16), b = parseInt(p.color.slice(5,7),16);
        return { input: p.color, rgb: `rgb(${r},${g},${b})`, r, g, b };
      }
      const m = p.color.match(/rgb\((\d+),(\d+),(\d+)\)/);
      if (m) {
        const [,r,g,b] = m;
        const hex = '#' + [r,g,b].map((n:string)=>parseInt(n).toString(16).padStart(2,'0')).join('');
        return { input: p.color, hex };
      }
      return { error: 'invalid color format' };
    }
    return { error: 'unsupported action' };
  },
};

export default function setup(router: Router) {
  router.register(colorCap);
}

export async function teardown(router: Router) {
  router.unregister('cap.color');
}
