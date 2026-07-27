/**
 * AST-based element deletion.
 *
 * The hard problem here isn't removing a JSX node — it's knowing WHICH node
 * to remove. A DOM element's own data-hb-file/line always points to wherever
 * its JSX tag is textually authored, which for a non-prop-forwarding custom
 * component (e.g. `<div>` inside ServiceCard.tsx) is the component's OWN
 * definition file, never the `<ServiceCard />` usage site in Services.tsx.
 * Deleting directly there would corrupt the shared component for every
 * instance, everywhere. The bridge additionally resolves the nearest
 * ancestor custom-component's own invocation site via the React fiber tree
 * (ImageOwnerInfo-style "ownerFile/Line/Col") — when the clicked element
 * turns out to be the SOLE root JSX a component function returns, deletion
 * redirects there instead of touching the component's definition.
 *
 * Mapped list items (`.map()`) are handled similarly: never remove the
 * shared JSX template, only the one data-array entry it was instantiated
 * from — resolved via data-hb-item-id when the project's own JSX authors it,
 * else by the item's DOM-order index among sibling instances.
 */
import * as fs from 'fs'
import * as path from 'path'
import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'
import type { NodePath } from '@babel/traverse'
import * as t from '@babel/types'
import { applySourceTransactionMulti, FileMutation, HistoryElementMeta } from './sourceTransaction'

const traverse = ((_traverse as unknown) as { default: typeof _traverse }).default ?? _traverse

// ─── public types ───────────────────────────────────────────────────────────

export interface DeleteElementParams {
  directFile: string
  directLine: number
  directCol?: number | null
  ownerFile?: string | null
  ownerLine?: number | null
  ownerCol?: number | null
  ownerComponentName?: string | null
  hbItemId?: string | null
  mappedIndex?: number | null
  projectPath: string
  description: string
  element?: HistoryElementMeta
  /** Correlates this write's log lines with the renderer's lifecycle logs — cosmetic only, never affects behaviour. */
  operationId?: string
}

export interface DeleteElementResult {
  success: boolean
  filePath?: string
  lineNumber?: number
  error?: string
  /** Machine-readable failure category, for the confirm dialog / future retry logic. */
  code?: 'TARGET_NOT_FOUND' | 'PROTECTED' | 'AMBIGUOUS' | 'WRITE_FAILED' | 'DELETE_FAILED'
  historyRecorded?: boolean
  skippedReason?: string
  deletedKind?: 'jsx-element' | 'component-instance' | 'mapped-item'
}

function log(operationId: string | undefined, msg: string): void {
  console.log(`[delete ${operationId ?? '(no-id)'}] ${msg}`)
}

// ─── shared parse helpers ───────────────────────────────────────────────────

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

// ─── protected elements ─────────────────────────────────────────────────────

const PROTECTED_TAGS = new Set(['html', 'head', 'body'])

function protectionReasonForTag(tagName: string): string | null {
  if (PROTECTED_TAGS.has(tagName.toLowerCase())) {
    return 'This structural element cannot be deleted safely.'
  }
  return null
}

// ─── exact JSX node lookup (line + column, no fuzzy fallback) ──────────────

interface LocatedJsx {
  path: NodePath<t.JSXOpeningElement>
  jsxElement: t.JSXElement
  tagName: string
  isComponent: boolean
}

function findExactJsxAt(ast: t.File, line: number, col?: number | null): LocatedJsx | null {
  const onLine: NodePath<t.JSXOpeningElement>[] = []
  traverse(ast, {
    JSXOpeningElement(p) {
      if (p.node.loc?.start.line === line) onLine.push(p)
    },
  })
  if (onLine.length === 0) return null
  const best = col != null
    ? onLine.reduce((a, b) => {
        const ac = (a.node.loc?.start.column ?? 0) + 1
        const bc = (b.node.loc?.start.column ?? 0) + 1
        return Math.abs(ac - col) <= Math.abs(bc - col) ? a : b
      })
    : onLine[0]
  const parent = best.parentPath
  if (!parent.isJSXElement()) return null
  const tagName = jsxTagName(best.node.name)
  return { path: best, jsxElement: parent.node, tagName, isComponent: isComponentTag(tagName) }
}

// ─── "is this the entire output of an exported component?" ────────────────

interface ComponentRootInfo {
  isRoot: boolean
  funcName: string | null
  isExported: boolean
}

function analyzeComponentRoot(path: NodePath<t.JSXOpeningElement>, jsxElement: t.JSXElement): ComponentRootInfo {
  const funcParent = path.getFunctionParent()
  if (!funcParent) return { isRoot: false, funcName: null, isExported: false }

  let returned: t.Node | null = null
  if (funcParent.isArrowFunctionExpression() && !t.isBlockStatement(funcParent.node.body)) {
    returned = funcParent.node.body
  } else {
    funcParent.traverse({
      ReturnStatement(p) {
        if (returned) return
        if (p.getFunctionParent() !== funcParent) return
        returned = p.node.argument ?? null
      },
    })
  }
  while (returned && t.isParenthesizedExpression(returned)) returned = returned.expression

  const isRoot = returned === jsxElement

  let funcName: string | null = null
  const funcNode = funcParent.node
  if ((t.isFunctionDeclaration(funcNode) || t.isFunctionExpression(funcNode)) && funcNode.id) {
    funcName = funcNode.id.name
  }
  if (!funcName && funcParent.parentPath?.isVariableDeclarator()) {
    const id = funcParent.parentPath.node.id
    if (t.isIdentifier(id)) funcName = id.name
  }

  let isExported = false
  let up: NodePath | null = funcParent
  while (up) {
    if (up.isExportNamedDeclaration() || up.isExportDefaultDeclaration()) { isExported = true; break }
    up = up.parentPath
  }

  return { isRoot, funcName, isExported }
}

// ─── ".map()" context (array identifier + optional data-hb-item-id expr) ──

interface MapContext {
  isMapped: boolean
  arrayName: string | null
  mapFuncPath: NodePath | null
}

function findMapContext(path: NodePath<t.JSXOpeningElement>): MapContext {
  const funcParent = path.getFunctionParent()
  if (!funcParent) return { isMapped: false, arrayName: null, mapFuncPath: null }
  const callPath = funcParent.parentPath
  if (
    callPath?.isCallExpression() &&
    t.isMemberExpression(callPath.node.callee) &&
    t.isIdentifier(callPath.node.callee.property, { name: 'map' })
  ) {
    const obj = callPath.node.callee.object
    return {
      isMapped: true,
      arrayName: t.isIdentifier(obj) ? obj.name : null,
      mapFuncPath: funcParent,
    }
  }
  return { isMapped: false, arrayName: null, mapFuncPath: null }
}

/** `data-hb-item-id={expr}` on this element or an ancestor within the same `.map()` callback — mirrors jsxLocator.ts's version. */
function findMapItemExpr(openingPath: NodePath<t.JSXOpeningElement>, mapFuncPath: NodePath, content: string): string | undefined {
  let current: NodePath | null = openingPath
  while (current) {
    if (current.isJSXOpeningElement()) {
      const attr = current.node.attributes.find(
        (a): a is t.JSXAttribute => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name, { name: 'data-hb-item-id' })
      )
      if (attr?.value && t.isJSXExpressionContainer(attr.value)) {
        const expr = attr.value.expression
        if (expr.start != null && expr.end != null) return content.slice(expr.start, expr.end)
      }
    }
    if (current === mapFuncPath) break
    current = current.parentPath
  }
  return undefined
}

// ─── array-literal resolution (same file, or one relative import hop) ─────

function findArrayLiteral(ast: t.File, arrayName: string): t.ArrayExpression | null {
  let found: t.ArrayExpression | null = null
  traverse(ast, {
    VariableDeclarator(p) {
      if (found) return
      if (t.isIdentifier(p.node.id, { name: arrayName }) && p.node.init && t.isArrayExpression(p.node.init)) {
        found = p.node.init
      }
    },
  })
  return found
}

interface ResolvedArray {
  filePath: string
  content: string
  ast: t.File
  node: t.ArrayExpression
}

function resolveArraySource(usageFilePath: string, usageContent: string, usageAst: t.File, arrayName: string): ResolvedArray | null {
  const local = findArrayLiteral(usageAst, arrayName)
  if (local) return { filePath: usageFilePath, content: usageContent, ast: usageAst, node: local }

  const importSourceHolder: { value: string | null } = { value: null }
  traverse(usageAst, {
    ImportDeclaration(p) {
      if (importSourceHolder.value) return
      for (const spec of p.node.specifiers) {
        const localName =
          (t.isImportDefaultSpecifier(spec) || t.isImportSpecifier(spec) || t.isImportNamespaceSpecifier(spec))
            ? spec.local.name : null
        if (localName === arrayName) importSourceHolder.value = p.node.source.value
      }
    },
  })
  const importSource = importSourceHolder.value
  if (!importSource || !importSource.startsWith('.')) return null

  const resolved = resolveFileWithExtensions(path.resolve(path.dirname(usageFilePath), importSource))
  if (!resolved) return null

  let content: string
  try {
    content = fs.readFileSync(resolved, 'utf-8')
  } catch {
    return null
  }
  const ast = parseSource(content)
  if (!ast) return null
  const node = findArrayLiteral(ast, arrayName)
  if (!node) return null
  return { filePath: resolved, content, ast, node }
}

// ─── text-splice removal, preserving formatting where possible ────────────

/** Remove a JSX node's own line(s) entirely if it occupies them alone; otherwise splice just its span (trimming one adjacent space). */
function removeJsxNode(content: string, node: t.Node): string {
  const start = node.start!
  const end = node.end!

  let lineStart = start
  while (lineStart > 0 && content[lineStart - 1] !== '\n') lineStart--
  const onlyWhitespaceBefore = /^\s*$/.test(content.slice(lineStart, start))

  let lineEnd = end
  while (lineEnd < content.length && content[lineEnd] !== '\n' && /[ \t\r]/.test(content[lineEnd])) lineEnd++
  const newlineAfter = content[lineEnd] === '\n'

  if (onlyWhitespaceBefore && newlineAfter) {
    return content.slice(0, lineStart) + content.slice(lineEnd + 1)
  }
  let s = start, e = end
  if (content[e] === ' ') e++
  else if (content[s - 1] === ' ') s--
  return content.slice(0, s) + content.slice(e)
}

/** Remove one element from an array literal by index, cleaning up the adjoining comma and, if the element was alone on its line, that whole line. */
function removeArrayElementAt(content: string, arrayNode: t.ArrayExpression, index: number): string | null {
  const el = arrayNode.elements[index]
  if (!el || el.start == null || el.end == null) return null

  let start = el.start
  let end = el.end

  // Prefer consuming a FOLLOWING comma (keeps a trailing comma on the new
  // last element from being left dangling only when this was the last one).
  let i = end
  while (i < content.length && content[i] !== '\n' && /\s/.test(content[i])) i++
  if (content[i] === ',') {
    end = i + 1
  } else {
    // last element — consume a PRECEDING comma instead
    let j = start - 1
    while (j >= 0 && content[j] !== '\n' && /\s/.test(content[j])) j--
    if (content[j] === ',') start = j
  }

  // If the element (now including its comma) is alone on its line, remove the whole line.
  let lineStart = start
  while (lineStart > 0 && content[lineStart - 1] !== '\n') lineStart--
  const onlyWhitespaceBefore = /^\s*$/.test(content.slice(lineStart, start))
  let lineEnd = end
  while (lineEnd < content.length && content[lineEnd] !== '\n' && /[ \t\r]/.test(content[lineEnd])) lineEnd++
  if (onlyWhitespaceBefore && content[lineEnd] === '\n') {
    return content.slice(0, lineStart) + content.slice(lineEnd + 1)
  }
  return content.slice(0, start) + content.slice(end)
}

// ─── mapped-item resolution + removal ──────────────────────────────────────

interface MappedDeletePlan {
  arrayFile: string
  mutate: (content: string) => { success: boolean; newContent?: string; error?: string }
}

function planMappedDeletion(
  usageFilePath: string,
  usageContent: string,
  usageAst: t.File,
  mapCtx: MapContext,
  openingPath: NodePath<t.JSXOpeningElement>,
  hbItemId: string | null | undefined,
  mappedIndex: number | null | undefined
): MappedDeletePlan | { error: string } {
  if (!mapCtx.arrayName) {
    return { error: 'This repeated element cannot yet be deleted safely because its source item could not be identified.' }
  }

  const resolvedArray = resolveArraySource(usageFilePath, usageContent, usageAst, mapCtx.arrayName)
  if (!resolvedArray) {
    return { error: 'This repeated element cannot yet be deleted safely because its source item could not be identified.' }
  }

  // Priority 1: data-hb-item-id, when the project's own JSX authors it.
  let targetIndex: number | null = null
  const mapItemExpr = mapCtx.mapFuncPath ? findMapItemExpr(openingPath, mapCtx.mapFuncPath, usageContent) : undefined
  if (mapItemExpr && hbItemId) {
    const m = /^[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)$/.exec(mapItemExpr.trim())
    const prop = m?.[1]
    if (prop) {
      const matches: number[] = []
      resolvedArray.node.elements.forEach((el, idx) => {
        if (!el || !t.isObjectExpression(el)) return
        for (const p of el.properties) {
          if (!t.isObjectProperty(p)) continue
          const key = t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : null
          if (key !== prop) continue
          let val: string | null = null
          if (t.isStringLiteral(p.value)) val = p.value.value
          else if (t.isNumericLiteral(p.value)) val = String(p.value.value)
          if (val === hbItemId) matches.push(idx)
        }
      })
      if (matches.length === 1) targetIndex = matches[0]
    }
  }

  // Priority 2: DOM-order index fallback.
  if (targetIndex === null && mappedIndex != null) {
    if (mappedIndex >= 0 && mappedIndex < resolvedArray.node.elements.length) targetIndex = mappedIndex
  }

  if (targetIndex === null) {
    return { error: 'This repeated element cannot yet be deleted safely because its source item could not be identified.' }
  }

  const finalIndex = targetIndex
  return {
    arrayFile: resolvedArray.filePath,
    mutate: (content: string) => {
      // Re-parse fresh in case this is the SAME file as an already-mutated
      // one in this transaction — applySourceTransactionMulti always hands
      // mutate() the current before-content, so re-resolving here is both
      // correct and cheap.
      const ast = parseSource(content)
      if (!ast) return { success: false, error: `${resolvedArray.filePath} could not be re-parsed` }
      const arr = findArrayLiteral(ast, mapCtx.arrayName!)
      if (!arr) return { success: false, error: `Could not re-locate the "${mapCtx.arrayName}" array in ${resolvedArray.filePath}` }
      const newContent = removeArrayElementAt(content, arr, finalIndex)
      if (newContent == null) return { success: false, error: 'Could not remove the array item cleanly' }
      return { success: true, newContent }
    },
  }
}

// ─── main entry point ───────────────────────────────────────────────────────

function deleteElementInner(params: DeleteElementParams): DeleteElementResult {
  const { directFile, directLine, directCol, ownerFile, ownerLine, ownerCol, projectPath, description, element, operationId } = params
  const opLog = (msg: string) => log(operationId, msg)

  opLog('main handler entered')

  let directContent: string
  try {
    directContent = fs.readFileSync(directFile, 'utf-8')
  } catch (err) {
    return { success: false, code: 'TARGET_NOT_FOUND', error: `Cannot read ${directFile}: ${String(err)}` }
  }
  opLog('source file resolved')

  const directAst = parseSource(directContent)
  if (!directAst) return { success: false, code: 'TARGET_NOT_FOUND', error: `${directFile} could not be parsed (syntax error?)` }
  opLog('AST parsed')

  const direct = findExactJsxAt(directAst, directLine, directCol)
  if (!direct) {
    return {
      success: false,
      code: 'TARGET_NOT_FOUND',
      error: `The source element could not be found at ${directFile}:${directLine}.`,
    }
  }
  opLog(`target node found — <${direct.tagName}>`)

  const protectedReason = protectionReasonForTag(direct.tagName)
  if (protectedReason) {
    return { success: false, code: 'PROTECTED', error: protectedReason }
  }

  const rootInfo = analyzeComponentRoot(direct.path, direct.jsxElement)

  // ── Case A: this element is the ENTIRE output of an exported component
  // (e.g. ServiceCard's own root <div>) — redirect to the component's usage
  // site instead of touching its shared definition. ──────────────────────
  if (rootInfo.isRoot && rootInfo.funcName && rootInfo.isExported) {
    if (!ownerFile || ownerLine == null) {
      return {
        success: false,
        code: 'AMBIGUOUS',
        error: `<${rootInfo.funcName}> is a shared component — deleting its root element here would affect every place it's used. Could not determine where <${rootInfo.funcName}> itself is used; select its usage directly.`,
      }
    }

    let ownerContent: string
    try {
      ownerContent = fs.readFileSync(ownerFile, 'utf-8')
    } catch (err) {
      return { success: false, code: 'TARGET_NOT_FOUND', error: `Cannot read ${ownerFile}: ${String(err)}` }
    }
    const ownerAst = parseSource(ownerContent)
    if (!ownerAst) return { success: false, code: 'TARGET_NOT_FOUND', error: `${ownerFile} could not be parsed (syntax error?)` }

    const owner = findExactJsxAt(ownerAst, ownerLine, ownerCol)
    if (!owner) {
      return { success: false, code: 'TARGET_NOT_FOUND', error: `Could not locate the <${rootInfo.funcName}> usage at ${ownerFile}:${ownerLine}.` }
    }

    const mapCtx = findMapContext(owner.path)
    if (mapCtx.isMapped) {
      const plan = planMappedDeletion(ownerFile, ownerContent, ownerAst, mapCtx, owner.path, params.hbItemId, params.mappedIndex)
      if ('error' in plan) return { success: false, code: 'AMBIGUOUS', error: plan.error }
      opLog('source transaction started')
      const result = applySourceTransactionMulti({
        projectPath, description, editType: 'delete', sourceLine: ownerLine, element,
        files: [{ filePath: plan.arrayFile, mutate: plan.mutate }],
      })
      opLog(`source written — success=${result.success}`)
      return { ...result, code: result.success ? undefined : 'WRITE_FAILED', deletedKind: 'mapped-item' }
    }

    const files: FileMutation[] = [{
      filePath: ownerFile,
      mutate: (content) => {
        const ast = parseSource(content)
        if (!ast) return { success: false, error: `${ownerFile} could not be re-parsed` }
        const located = findExactJsxAt(ast, ownerLine, ownerCol)
        if (!located) return { success: false, error: `Could not re-locate the <${rootInfo.funcName}> usage in ${ownerFile}` }
        return { success: true, newContent: removeJsxNode(content, located.jsxElement) }
      },
    }]
    opLog('source transaction started')
    const result = applySourceTransactionMulti({ projectPath, description, editType: 'delete', sourceLine: ownerLine, element, files })
    opLog(`source written — success=${result.success}`)
    return { ...result, code: result.success ? undefined : 'WRITE_FAILED', deletedKind: 'component-instance' }
  }

  // ── Case B: a plain intrinsic (or non-root component usage) directly
  // inside a `.map()` — remove the data item, never the shared template. ──
  const directMapCtx = findMapContext(direct.path)
  if (directMapCtx.isMapped) {
    const plan = planMappedDeletion(directFile, directContent, directAst, directMapCtx, direct.path, params.hbItemId, params.mappedIndex)
    if ('error' in plan) return { success: false, code: 'AMBIGUOUS', error: plan.error }
    opLog('source transaction started')
    const result = applySourceTransactionMulti({
      projectPath, description, editType: 'delete', sourceLine: directLine, element,
      files: [{ filePath: plan.arrayFile, mutate: plan.mutate }],
    })
    opLog(`source written — success=${result.success}`)
    return { ...result, code: result.success ? undefined : 'WRITE_FAILED', deletedKind: 'mapped-item' }
  }

  // ── Case C: an ordinary, directly-authored JSX element. ─────────────────
  const files: FileMutation[] = [{
    filePath: directFile,
    mutate: (content) => {
      const ast = parseSource(content)
      if (!ast) return { success: false, error: `${directFile} could not be re-parsed` }
      const located = findExactJsxAt(ast, directLine, directCol)
      if (!located) return { success: false, error: `Could not re-locate the element in ${directFile}` }
      return { success: true, newContent: removeJsxNode(content, located.jsxElement) }
    },
  }]
  opLog('source transaction started')
  const result = applySourceTransactionMulti({ projectPath, description, editType: 'delete', sourceLine: directLine, element, files })
  opLog(`source written — success=${result.success}`)
  return { ...result, code: result.success ? undefined : 'WRITE_FAILED', deletedKind: 'jsx-element' }
}

/**
 * Public entry point — wraps deleteElementInner in a top-level try/catch so
 * an unexpected exception ANYWHERE in AST location/traversal (a null
 * dereference, an unhandled node shape, …) always comes back as a plain
 * serialisable failure result instead of an uncaught throw that would leave
 * the IPC promise unresolved on the renderer side.
 */
export function deleteElement(params: DeleteElementParams): DeleteElementResult {
  try {
    const result = deleteElementInner(params)
    log(params.operationId, `IPC response returned — success=${result.success}`)
    return result
  } catch (err) {
    console.error(`[delete ${params.operationId ?? '(no-id)'}] unexpected exception:`, err)
    return {
      success: false,
      code: 'DELETE_FAILED',
      error: err instanceof Error ? err.message : 'Unknown deletion error',
    }
  }
}
