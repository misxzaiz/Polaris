/**
 * reactImportRewrite 单测：代码上下文感知重写
 *
 * 回归背景：plugin-forge 面板的脚手架模板（内嵌 react import 的字符串）曾被
 * 裸正则改写，注入的 blob URL 破坏 bundle 语法（Unexpected identifier 'blob'）。
 */
import { describe, expect, it } from 'vitest'
import { rewriteReactImports } from './reactImportRewrite'

const SHIM = 'blob:https://tauri.localhost/shim-uuid'

describe('rewriteReactImports：真 import 被重写', () => {
  it('from "react" / from \'react\' 双引号单引号都重写（保留原引号风格）', () => {
    expect(rewriteReactImports(`import x from "react"`, SHIM)).toBe(`import x from "${SHIM}"`)
    expect(rewriteReactImports(`import x from 'react'`, SHIM)).toBe(`import x from '${SHIM}'`)
  })
  it('react/jsx-runtime 重写为同一 shim', () => {
    expect(rewriteReactImports(`import { jsx } from "react/jsx-runtime"`, SHIM))
      .toBe(`import { jsx } from "${SHIM}"`)
  })
  it('require 形式重写', () => {
    expect(rewriteReactImports(`const r = require("react")`, SHIM)).toBe(`const r = require("${SHIM}")`)
    expect(rewriteReactImports(`const r = require( 'react/jsx-runtime' )`, SHIM))
      .toBe(`const r = require('${SHIM}')`)
  })
  it('react-spring 等相近模块名不误伤', () => {
    expect(rewriteReactImports(`import spring from "react-spring"`, SHIM))
      .toBe(`import spring from "react-spring"`)
  })
})

describe('rewriteReactImports：字符串/模板/注释内的同名文本原样保留', () => {
  it('单引号字符串里的 react import 不改写（plugin-forge 回归样例）', () => {
    const code = `var tpl = "import React, { useEffect } from 'react'\\nexport {}"`
    expect(rewriteReactImports(code, SHIM)).toBe(code)
  })
  it('模板字面量里的代码模板不改写（esbuild 反引号内联形态）', () => {
    const code = 'var tpl = `import React from "react"\nimport { jsx } from "react/jsx-runtime"`'
    expect(rewriteReactImports(code, SHIM)).toBe(code)
  })
  it('真 import 与模板字面量共存：只改真的', () => {
    const code = 'import { useState } from "react"\nvar tpl = `import React from "react"`'
    expect(rewriteReactImports(code, SHIM)).toBe(`import { useState } from "${SHIM}"\nvar tpl = \`import React from "react"\``)
  })
  it('注释里的 react import 不改写', () => {
    const code = `// import x from 'react'\n/* from "react" */\nimport y from "react"`
    expect(rewriteReactImports(code, SHIM)).toBe(`// import x from 'react'\n/* from "react" */\nimport y from "${SHIM}"`)
  })
  it('转义引号不终止字符串扫描', () => {
    const code = `var s = "结尾转义 \\" 再来 from 'react'"; import z from "react"`
    expect(rewriteReactImports(code, SHIM)).toBe(`var s = "结尾转义 \\" 再来 from 'react'"; import z from "${SHIM}"`)
  })
})

describe('rewriteReactImports：正则字面量（feed-radar 回归——含引号的正则曾致全文件配对错位）', () => {
  it('含引号的正则 /"/g 不被当字符串边界，后续 import 照常重写', () => {
    const code = `const esc = (s) => s.replace(/"/g, "&quot;");\nimport q from "react"`
    expect(rewriteReactImports(code, SHIM)).toBe(`const esc = (s) => s.replace(/"/g, "&quot;");\nimport q from "${SHIM}"`)
  })
  it('字符类正则与除法各归其位', () => {
    const code = `const r = /["']/; const half = total / 2;\nimport w from 'react'`
    expect(rewriteReactImports(code, SHIM)).toBe(`const r = /["']/; const half = total / 2;\nimport w from '${SHIM}'`)
  })
  it('return 后的正则与标识符后的除法', () => {
    const code = `function f() { return /react/g.test("react"); }\nconst d = len / 2\nimport e from "react"`
    const out = rewriteReactImports(code, SHIM)
    expect(out).toContain('/react/g.test("react")')
    expect(out).toContain('len / 2')
    expect(out).toContain(`import e from "${SHIM}"`)
  })
})
