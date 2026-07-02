/**
 * AST-based binding resolver for JSX/TSX source files.
 *
 * When the located text-search (analyzeLocatedEdit) finds 0 matches — because
 * the displayed text comes from a JSX expression, a variable, or an object
 * property rather than a bare string literal — this module parses the source
 * AST, locates the JSX element at the known source line, and returns one or
 * more "bindings": exact byte-level edit locations that commitTextEdit can apply.
 *
 * Supported binding kinds (in priority order):
 *   jsx-text         – Direct JSXText child (only child, or only non-whitespace text)
 *   jsx-text-partial – Direct JSXText child among JSXElement siblings (mixed content)
 *   identifier       – {someVar} → const/let/var someVar = "value"
 *   member           – {obj.prop} → const obj = { prop: "value", … }
 *   jsx-attr         – <Comp label="value" /> → JSX attribute StringLiteral
 *   jsx-attr-member  – <Comp label={obj.prop} /> → same as member
 *
 * Limitations:
 *   - Cross-file identifiers (imports) are not followed.
 *   - Template literals are not handled.
 *   - Multi-level member expressions (a.b.c) only follow one level.
 *   - Props passed through multiple layers of components are not resolved.
 */

import * as fs from 'fs'
import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'
import type { NodePath, Scope } from '@babel/traverse'
import * as t from '@babel/types'

// CJS/ESM interop — electron-vite externalises deps so they arrive as CJS
const traverse = ((_traverse as unknown) as { default: typeof _traverse }).default ?? _traverse

// ─── public types ─────────────────────────────────────────────────────────────

export interface AstBinding {
  kind: 'jsx-text' | 'jsx-text-partial' | 'identifier' | 'member' | 'jsx-attr' | 'jsx-attr-member'
  description: string
  filePath: string
  lineNumber: number
  /** Exact substring in the source file that will be replaced. */
  oldText: string
  /** The replacement string (same length semantics as commitTextEdit). */
  newText: string
  /** Byte offset into the file — passed to commitTextEdit for safe replacement. */
  matchOffset: number
}

export interface AstLocateParams {
  filePath: string
  lineNumber: number
  colNumber?: number | null
  /** Full el.textContent of the edited element (what the user sees). */
  displayedOld: string
  /** What the user typed as the new content. */
  displayedNew: string
}

export interface AstLocateResult {
  success: boolean
  bindings: AstBinding[]
  /** Human-readable explanation of what was tried. */
  reason: string
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * Extract the plain text that a JSX element would render, handling JSXText
 * and recursive JSXElement children.  Used to know what child elements
 * contribute to the parent's textContent so we can subtract it.
 */
function extractJsxText(node: t.JSXElement | t.JSXFragment): string {
  let out = ''
  for (const child of node.children) {
    if (t.isJSXText(child)) {
      out += normalizeWs(child.value)
    } else if (t.isJSXElement(child) || t.isJSXFragment(child)) {
      out += extractJsxText(child)
    } else if (t.isJSXExpressionContainer(child) && t.isStringLiteral(child.expression)) {
      out += child.expression.value
    }
  }
  return out.trim()
}

/**
 * Given the full displayed text (old), the new user text, the direct-text
 * portion (what the JSXText node itself renders), and what child JSXElements
 * contribute, compute what the JSXText node's trimmed content should become.
 *
 * Example:
 *   displayedOld = "Get Started→"
 *   displayedNew = "Start Today→"
 *   directOld    = "Get Started"
 *   childText    = "→"
 *   → returns "Start Today"
 */
function computeNewDirectText(
  displayedOld: string,
  displayedNew: string,
  directOld: string,
  childText: string
): string {
  const newNorm = normalizeWs(displayedNew)
  const childNorm = normalizeWs(childText)

  if (!childNorm) return newNorm

  // Child text at end (most common: text + icon)
  if (newNorm.endsWith(childNorm)) {
    return newNorm.slice(0, newNorm.length - childNorm.length).trim()
  }
  // Child text at start
  if (newNorm.startsWith(childNorm)) {
    return newNorm.slice(childNorm.length).trim()
  }
  // Remove wherever it appears
  const without = newNorm.replace(childNorm, '').trim()
  if (without !== newNorm) return without

  return newNorm
}

// ─── AST parsing ─────────────────────────────────────────────────────────────

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

/**
 * Collect JSXElement candidates near targetLine, sorted by distance from the
 * opening-tag line.  Also appends the parent of the nearest element so callers
 * can fall back to it when the nearest candidate has no matching bindings.
 */
function findJsxCandidates(
  ast: t.File,
  targetLine: number
): NodePath<t.JSXElement>[] {
  const found: Array<{ path: NodePath<t.JSXElement>; dist: number }> = []

  traverse(ast, {
    JSXElement(path) {
      const loc = path.node.openingElement.loc?.start
      if (!loc) return
      const dist = Math.abs(loc.line - targetLine)
      if (dist <= 8) found.push({ path, dist })
    },
  })

  found.sort((a, b) => a.dist - b.dist)

  // Append parent of nearest as a fallback (may be > 8 lines away)
  if (found.length > 0) {
    const nearestParent = found[0].path.parentPath
    if (nearestParent?.isJSXElement()) {
      const alreadyIncluded = found.some((f) => f.path.node === nearestParent.node)
      if (!alreadyIncluded) {
        found.push({ path: nearestParent as NodePath<t.JSXElement>, dist: Infinity })
      }
    }
  }

  return found.map((f) => f.path)
}

// ─── binding resolvers ────────────────────────────────────────────────────────

function resolveJsxTextBindings(
  jsxPath: NodePath<t.JSXElement>,
  params: AstLocateParams,
  content: string
): AstBinding[] {
  const children = jsxPath.node.children
  const textChildren  = children.filter(t.isJSXText)
  const elemChildren  = children.filter((c): c is t.JSXElement | t.JSXFragment =>
    t.isJSXElement(c) || t.isJSXFragment(c))

  const childElemText = elemChildren.map(extractJsxText).join('')

  const bindings: AstBinding[] = []

  for (const node of textChildren) {
    if (node.start == null || node.end == null) continue
    const rawSource = content.slice(node.start, node.end)
    const trimmed   = rawSource.trim()
    if (!trimmed) continue  // whitespace-only JSXText

    // Check this text node is plausibly the one being edited
    const displayedNorm = normalizeWs(params.displayedOld)
    const trimmedNorm   = normalizeWs(trimmed)
    if (!displayedNorm.includes(trimmedNorm)) continue

    const newDirect  = computeNewDirectText(params.displayedOld, params.displayedNew, trimmed, childElemText)
    const newSource  = rawSource.replace(trimmed, newDirect)
    const isPartial  = elemChildren.length > 0

    const tagName = jsxPath.node.openingElement.name
    const tagStr  = t.isJSXIdentifier(tagName) ? tagName.name : 'element'

    bindings.push({
      kind:        isPartial ? 'jsx-text-partial' : 'jsx-text',
      description: isPartial
        ? `Text node in <${tagStr}> (${trimmed})`
        : `Literal text in <${tagStr}>`,
      filePath:    params.filePath,
      lineNumber:  content.slice(0, node.start).split('\n').length,
      oldText:     rawSource,
      newText:     newSource,
      matchOffset: node.start,
    })
  }

  return bindings
}

function resolveIdentifierValue(
  name: string,
  scope: Scope,
  displayedOld: string,
  displayedNew: string,
  content: string,
  filePath: string
): AstBinding | null {
  const binding = scope.getBinding(name)
  if (!binding) return null

  const declPath = binding.path
  if (!declPath.isVariableDeclarator()) return null

  const init = declPath.node.init
  if (!t.isStringLiteral(init) || init.start == null || init.end == null) return null

  const currentValue = init.value
  if (!normalizeWs(displayedOld).includes(normalizeWs(currentValue))) return null

  const rawSource = content.slice(init.start, init.end)
  const quote     = rawSource[0] === "'" ? "'" : '"'
  const newValue  = computeNewDirectText(displayedOld, displayedNew, currentValue, '')

  return {
    kind:        'identifier',
    description: `const ${name} = ${rawSource}`,
    filePath,
    lineNumber:  content.slice(0, init.start).split('\n').length,
    oldText:     rawSource,
    newText:     `${quote}${newValue}${quote}`,
    matchOffset: init.start,
  }
}

function resolveMemberValue(
  objName: string,
  propName: string,
  scope: Scope,
  displayedOld: string,
  displayedNew: string,
  content: string,
  filePath: string
): AstBinding | null {
  const binding = scope.getBinding(objName)
  if (!binding) return null

  const declPath = binding.path
  if (!declPath.isVariableDeclarator()) return null

  const init = declPath.node.init
  if (!t.isObjectExpression(init)) return null

  for (const prop of init.properties) {
    if (!t.isObjectProperty(prop)) continue
    const key = prop.key
    if (!(t.isIdentifier(key) && key.name === propName) &&
        !(t.isStringLiteral(key) && key.value === propName)) continue
    if (!t.isStringLiteral(prop.value)) continue
    if (prop.value.start == null || prop.value.end == null) continue

    const currentValue = prop.value.value
    if (!normalizeWs(displayedOld).includes(normalizeWs(currentValue))) continue

    const rawSource = content.slice(prop.value.start, prop.value.end)
    const quote     = rawSource[0] === "'" ? "'" : '"'
    const newValue  = computeNewDirectText(displayedOld, displayedNew, currentValue, '')

    return {
      kind:        'member',
      description: `${objName}.${propName} = ${rawSource}`,
      filePath,
      lineNumber:  content.slice(0, prop.value.start).split('\n').length,
      oldText:     rawSource,
      newText:     `${quote}${newValue}${quote}`,
      matchOffset: prop.value.start,
    }
  }

  return null
}

function resolveExpressionBindings(
  jsxPath: NodePath<t.JSXElement>,
  params: AstLocateParams,
  content: string
): AstBinding[] {
  const bindings: AstBinding[] = []

  for (const childPath of jsxPath.get('children') as NodePath<t.Node>[]) {
    if (!childPath.isJSXExpressionContainer()) continue

    const exprPath = (childPath as NodePath<t.JSXExpressionContainer>).get('expression')

    if (exprPath.isIdentifier()) {
      const b = resolveIdentifierValue(
        exprPath.node.name,
        exprPath.scope,
        params.displayedOld,
        params.displayedNew,
        content,
        params.filePath
      )
      if (b) bindings.push(b)
    }

    if (exprPath.isMemberExpression()) {
      const obj  = exprPath.get('object')  as NodePath<t.Node>
      const prop = exprPath.get('property') as NodePath<t.Node>
      if (obj.isIdentifier() && prop.isIdentifier()) {
        const b = resolveMemberValue(
          obj.node.name,
          prop.node.name,
          exprPath.scope,
          params.displayedOld,
          params.displayedNew,
          content,
          params.filePath
        )
        if (b) bindings.push(b)
      }
    }
  }

  return bindings
}

function resolveAttrBindings(
  jsxPath: NodePath<t.JSXElement>,
  params: AstLocateParams,
  content: string
): AstBinding[] {
  const bindings: AstBinding[] = []

  for (const attrPath of jsxPath.get('openingElement').get('attributes') as NodePath<t.Node>[]) {
    if (!attrPath.isJSXAttribute()) continue
    const valuePath = (attrPath as NodePath<t.JSXAttribute>).get('value')

    // label="literal"
    if (valuePath.isStringLiteral()) {
      const node = valuePath.node as t.StringLiteral
      if (node.start == null || node.end == null) continue
      const currentValue = node.value
      if (!normalizeWs(params.displayedOld).includes(normalizeWs(currentValue))) continue

      const rawSource = content.slice(node.start, node.end)
      const quote     = rawSource[0] === "'" ? "'" : '"'
      const newValue  = computeNewDirectText(params.displayedOld, params.displayedNew, currentValue, '')
      const attrName  = attrPath.isJSXAttribute()
        ? ((attrPath.node as t.JSXAttribute).name as t.JSXIdentifier).name
        : '?'

      bindings.push({
        kind:        'jsx-attr',
        description: `prop ${attrName}="${currentValue}"`,
        filePath:    params.filePath,
        lineNumber:  content.slice(0, node.start).split('\n').length,
        oldText:     rawSource,
        newText:     `${quote}${newValue}${quote}`,
        matchOffset: node.start,
      })
    }

    // label={obj.prop}
    if (valuePath.isJSXExpressionContainer()) {
      const exprPath = (valuePath as NodePath<t.JSXExpressionContainer>).get('expression') as NodePath<t.Node>
      if (exprPath.isMemberExpression()) {
        const obj  = exprPath.get('object')   as NodePath<t.Node>
        const prop = exprPath.get('property') as NodePath<t.Node>
        if (obj.isIdentifier() && prop.isIdentifier()) {
          const b = resolveMemberValue(
            obj.node.name,
            prop.node.name,
            exprPath.scope,
            params.displayedOld,
            params.displayedNew,
            content,
            params.filePath
          )
          if (b) { bindings.push({ ...b, kind: 'jsx-attr-member' }); }
        }
      }
    }
  }

  return bindings
}

// ─── public API ───────────────────────────────────────────────────────────────

export function astLocateBinding(params: AstLocateParams): AstLocateResult {
  const FAIL = (reason: string): AstLocateResult => ({ success: false, bindings: [], reason })

  console.log(
    `[astEditor] astLocateBinding called: ${params.filePath}:${params.lineNumber}`,
    `| displayedOld=${JSON.stringify(params.displayedOld.slice(0, 80))}`,
    `| displayedNew=${JSON.stringify(params.displayedNew.slice(0, 80))}`
  )

  if (!params.filePath || !params.lineNumber) {
    console.log('[astEditor] FAIL: no source file or line number')
    return FAIL('No source file or line number')
  }

  let content: string
  try {
    content = fs.readFileSync(params.filePath, 'utf-8')
    console.log(`[astEditor] read file OK (${content.length} bytes, ${content.split('\n').length} lines)`)
  } catch (err) {
    console.log('[astEditor] FAIL: could not read file:', err)
    return FAIL(`Could not read file: ${err}`)
  }

  const ast = parseSource(content)
  if (!ast) {
    console.log('[astEditor] FAIL: parse error')
    return FAIL('File could not be parsed (syntax error?)')
  }

  const candidates = findJsxCandidates(ast, params.lineNumber)
  console.log(
    `[astEditor] candidates near line ${params.lineNumber}:`,
    candidates.map((c) => {
      const n = c.node.openingElement.name
      const tag = t.isJSXIdentifier(n) ? n.name : '?'
      const line = c.node.openingElement.loc?.start.line ?? '?'
      return `<${tag}> @L${line}`
    })
  )

  if (candidates.length === 0) {
    const msg = `No JSX element found within ±8 lines of line ${params.lineNumber}`
    console.log('[astEditor] FAIL:', msg)
    return FAIL(msg)
  }

  // Try each candidate in order until one yields bindings
  const seen = new Set<number>()
  let usedTag = '?'
  let usedLine: number | string = '?'
  let allBindings: AstBinding[] = []

  for (const jsxPath of candidates) {
    const tagName   = jsxPath.node.openingElement.name
    const tagStr    = t.isJSXIdentifier(tagName) ? tagName.name : '?'
    const foundLine = jsxPath.node.openingElement.loc?.start.line ?? params.lineNumber

    const childNames = jsxPath.node.children
      .filter((c): c is t.JSXText | t.JSXElement => t.isJSXText(c) || t.isJSXElement(c))
      .map((c) => {
        if (t.isJSXText(c)) return `JSXText(${JSON.stringify(c.value.trim().slice(0, 30))})`
        const n2 = (c as t.JSXElement).openingElement.name
        return `<${t.isJSXIdentifier(n2) ? n2.name : '?'}>`
      })

    console.log(
      `[astEditor] trying <${tagStr}> @L${foundLine}:`,
      `children=[${childNames.join(', ')}]`
    )

    const bindings: AstBinding[] = [
      ...resolveJsxTextBindings(jsxPath, params, content),
      ...resolveExpressionBindings(jsxPath, params, content),
      ...resolveAttrBindings(jsxPath, params, content),
    ]

    console.log(`[astEditor]   → ${bindings.length} raw binding(s):`, bindings.map((b) => `${b.kind}@L${b.lineNumber}(${JSON.stringify(b.oldText.trim().slice(0, 30))})`))

    if (bindings.length > 0) {
      usedTag  = tagStr
      usedLine = foundLine
      allBindings = bindings
      break
    }
  }

  // Deduplicate by matchOffset
  const unique = allBindings.filter((b) => {
    if (seen.has(b.matchOffset)) return false
    seen.add(b.matchOffset)
    return true
  })

  console.log(
    `[astEditor] final result: <${usedTag}> @L${usedLine} →`,
    `${unique.length} unique binding(s):`,
    unique.map((b) => `${b.kind}@L${b.lineNumber}`)
  )

  if (unique.length === 0) {
    return {
      success:  false,
      bindings: [],
      reason:   `Tried ${candidates.length} candidate(s) near line ${params.lineNumber} — none had text matching "${params.displayedOld.trim().slice(0, 40)}"`,
    }
  }

  return {
    success:  true,
    bindings: unique,
    reason:   `Found <${usedTag}> at line ${usedLine}, ${unique.length} binding(s)`,
  }
}
