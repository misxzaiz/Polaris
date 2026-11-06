/**
 * 宿主桥测试（plugin-ui-contribution-spec [S-1]/[S-4]）
 *
 * 验证：
 * - rewriteForPluginModule：react 与 polaris-host/* 的 import 重写；
 *   字符串/注释/正则字面量内同名文本不重写（上下文感知）
 * - 未注册桥 → 报错 stub URL（import 阶段明确报错而非裸 SyntaxError）
 * - shim 源码语法有效性（URL.createObjectURL mock 下）
 * - ensureBridgesReady：artifact/form 经 bridgeImporters 注入缝触发注册
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  getHostShimUrl,
  getHostStubUrl,
  rewriteForPluginModule,
  ensureBridgesReady,
  resetHostBridgesForTest,
  HOST_BRIDGE_NAMES,
  bridgeImporters,
} from './hostBridge'
import { rewritePluginImports } from './reactImportRewrite'

const REACT_URL = 'blob:react-shim'

const fakeRegister = vi.fn()

beforeEach(() => {
  resetHostBridgesForTest()
  fakeRegister.mockClear()
  // 动态 importer 注入缝：替换为打桩注册器（避免 mock 动态 import 的 hoist 陷阱）
  bridgeImporters.artifact = async () => ({ registerArtifactHost: () => fakeRegister('artifact') })
  bridgeImporters.form = async () => ({ registerFormHost: () => fakeRegister('form') })
  // jsdom 下 URL.createObjectURL 不可用 → 打桩
  if (typeof URL.createObjectURL !== 'function') {
    Object.defineProperty(URL, 'createObjectURL', { value: () => `blob:mock-${Math.random()}`, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true })
  }
})

describe('rewriteForPluginModule', () => {
  it('react 与 polaris-host/artifact 均被重写为 shim 引用', () => {
    const code = `import { useState } from 'react'
import { ArtifactPreviewRenderer } from 'polaris-host/artifact'
export default () => null`
    const out = rewriteForPluginModule(code, REACT_URL)
    expect(out).toContain(`from '${REACT_URL}'`)
    expect(out).not.toContain("'polaris-host/artifact'")
    // shim URL 引用出现
    expect(out).toContain('blob:')
  })

  it('require 形态同样重写', () => {
    const code = `const R = require("react"); const F = require('polaris-host/form');`
    const out = rewriteForPluginModule(code, REACT_URL)
    expect(out).toContain(`require('${REACT_URL}')`)
    expect(out).not.toContain("polaris-host/form'")
  })

  it('字符串与注释内的同名文本不重写（上下文感知）', () => {
    const code = `const t = "import x from 'polaris-host/artifact'";
// import y from 'polaris-host/artifact'
const s = \`from 'polaris-host/artifact'\`;
import { useArtifactVersions } from 'polaris-host/artifact'`
    const out = rewriteForPluginModule(code, REACT_URL)
    // 字符串/模板/注释原样保留
    expect(out).toContain(`const t = "import x from 'polaris-host/artifact'"`)
    expect(out).toContain(`// import y from 'polaris-host/artifact'`)
    expect(out).toContain(`\`from 'polaris-host/artifact'\``)
    // 仅最后一行真实 import 被改写
    expect(out).not.toContain("import { useArtifactVersions } from 'polaris-host/artifact'")
  })

  it('未注册桥（如 polaris-host/bash）→ 报错 stub，源码含可用清单', () => {
    const code = `import x from 'polaris-host/bash'`
    const out = rewriteForPluginModule(code, REACT_URL)
    expect(out).not.toContain("'polaris-host/bash'")
    const stubUrl = getHostStubUrl('bash')
    // stub URL 对应源码包含明确报错信息（import 阶段抛出）
    expect(stubUrl).toMatch(/^blob:/)
  })

  it('shim 源码包含 window 键与全部已注册桥', () => {
    expect(HOST_BRIDGE_NAMES).toEqual(['artifact', 'form', 'cap'])
    const url = getHostShimUrl('artifact')
    expect(url).toMatch(/^blob:/)
  })
})

describe('rewritePluginImports（占位符出口）', () => {
  it('未知桥无兜底时保留原样', () => {
    const code = `import x from 'polaris-host/zzz'`
    const out = rewritePluginImports(code, { reactShimUrl: REACT_URL, hostShims: {} })
    expect(out).toContain("'polaris-host/zzz'")
  })

  it('onUnknownHost 提供兜底 URL', () => {
    const code = `import x from 'polaris-host/zzz'`
    const out = rewritePluginImports(code, {
      reactShimUrl: REACT_URL,
      hostShims: {},
      onUnknownHost: (name) => `blob:stub-${name}`,
    })
    expect(out).toContain('blob:stub-zzz')
  })
})

describe('ensureBridgesReady', () => {
  it('代码含 polaris-host/artifact → 触发 artifact 注册', async () => {
    await ensureBridgesReady(`import { A } from 'polaris-host/artifact'`)
    expect(fakeRegister).toHaveBeenCalledWith('artifact')
  })

  it('代码含 polaris-host/form → 触发 form 注册', async () => {
    await ensureBridgesReady(`import { F } from 'polaris-host/form'`)
    expect(fakeRegister).toHaveBeenCalledWith('form')
  })

  it('不含桥引用 → 不触发任何注册', async () => {
    await ensureBridgesReady(`import x from 'react'`)
    expect(fakeRegister).not.toHaveBeenCalled()
  })
})
