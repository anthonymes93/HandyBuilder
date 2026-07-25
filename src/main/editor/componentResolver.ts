/**
 * Resolves a JSX component invocation (e.g. `<Button href="/contact">` in
 * Hero.tsx) to the file that defines it, so a "style all instances" choice
 * can locate the component's own rendered intrinsic element (e.g. the `<a>`
 * inside Button.tsx). Only follows local relative imports — never
 * node_modules/library components.
 */
import * as fs from 'fs'
import * as path from 'path'
import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'
import * as t from '@babel/types'

const traverse = ((_traverse as unknown) as { default: typeof _traverse }).default ?? _traverse

export interface ResolvedComponent {
  filePath: string
  /** The first intrinsic (lowercase) JSX tag found in the component's body — our best guess at its root render target. */
  rootTagName?: string
  /** Source line of that root intrinsic element within filePath. */
  rootLine?: number
  /** True if that intrinsic element spreads props (`{...rest}`) — a signal that className/style passed to the component will reach it. */
  forwardsProps: boolean
}

function parseSource(content: string): t.File | null {
  try {
    return parse(content, {
      sourceType: 'module',
      allowImportExportEverywhere: true,
      allowReturnOutsideFunction: true,
      startLine: 1,
      plugins: ['typescript', 'jsx'],
    })
  } catch {
    return null
  }
}

function jsxTagName(nameNode: t.JSXOpeningElement['name']): string {
  if (t.isJSXIdentifier(nameNode)) return nameNode.name
  if (t.isJSXMemberExpression(nameNode) && t.isJSXIdentifier(nameNode.property)) return nameNode.property.name
  return ''
}

function isComponentTag(name: string): boolean {
  return /[A-Z]/.test(name[0] ?? '') || name.includes('.')
}

function resolveFileWithExtensions(base: string): string | null {
  const candidates = [
    base,
    `${base}.tsx`, `${base}.jsx`, `${base}.ts`, `${base}.js`,
    path.join(base, 'index.tsx'), path.join(base, 'index.jsx'), path.join(base, 'index.ts'), path.join(base, 'index.js'),
  ]
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c
    } catch { /* try next */ }
  }
  return null
}

function analyzeComponentFile(filePath: string): { rootTagName?: string; rootLine?: number; forwardsProps: boolean } {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return { forwardsProps: false }
  }
  const ast = parseSource(content)
  if (!ast) return { forwardsProps: false }

  let rootTagName: string | undefined
  let rootLine: number | undefined
  let forwardsProps = false

  traverse(ast, {
    JSXOpeningElement(path) {
      if (rootTagName) return // first intrinsic element found — best-effort "root" guess
      const name = jsxTagName(path.node.name)
      if (!name || isComponentTag(name)) return
      rootTagName = name
      rootLine = path.node.loc?.start.line
      forwardsProps = path.node.attributes.some((a) => t.isJSXSpreadAttribute(a))
      path.stop()
    },
  })

  return { rootTagName, rootLine, forwardsProps }
}

/**
 * Given the file where a component is USED (e.g. Hero.tsx) and the component
 * name (e.g. "Button"), find the local file that defines it and report
 * whether it looks like it forwards className/style to its rendered element.
 */
export function resolveComponentImport(usageFilePath: string, componentName: string): ResolvedComponent | null {
  let content: string
  try {
    content = fs.readFileSync(usageFilePath, 'utf-8')
  } catch {
    return null
  }
  const ast = parseSource(content)
  if (!ast) return null

  const foundImportSources: string[] = []
  traverse(ast, {
    ImportDeclaration(path) {
      for (const spec of path.node.specifiers) {
        const localName =
          (t.isImportDefaultSpecifier(spec) || t.isImportSpecifier(spec) || t.isImportNamespaceSpecifier(spec))
            ? spec.local.name
            : null
        if (localName === componentName) {
          foundImportSources.push(path.node.source.value)
          path.stop()
        }
      }
    },
  })

  const importSource = foundImportSources[0]
  if (!importSource || !importSource.startsWith('.')) return null // skip node_modules/library components

  const resolved = resolveFileWithExtensions(path.resolve(path.dirname(usageFilePath), importSource))
  if (!resolved) return null

  const { rootTagName, rootLine, forwardsProps } = analyzeComponentFile(resolved)
  return { filePath: resolved, rootTagName, rootLine, forwardsProps }
}
