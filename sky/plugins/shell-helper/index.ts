/**
 * 示例插件: shell.info
 * 演示插件如何注册自己的 cap 到 Router
 */

import type { Capability } from '../../src/contracts.ts';
import type { Router } from '../../src/server/router.ts';

const shellInfoCap: Capability = {
  id: 'cap.shell.info',
  description: 'Returns shell/environment info (platform, arch, node version).',
  inputSchema: {
    type: 'object',
    properties: {
      detail: { type: 'boolean', description: 'Include detailed env vars' },
    },
  },
  async invoke(params) {
    const p = (params ?? {}) as { detail?: boolean };
    const info: Record<string, unknown> = {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      pid: process.pid,
      cwd: process.cwd(),
    };
    if (p.detail) {
      info.env = {
        PATH: process.env.PATH?.slice(0, 200),
        HOME: process.env.HOME || process.env.USERPROFILE,
      };
    }
    return info;
  },
};

export default function setup(router: Router) {
  router.register(shellInfoCap);
}
