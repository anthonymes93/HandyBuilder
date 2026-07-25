/**
 * Robust JSX element locator for the visual style editor.
 *
 * The previous implementation (styleWriter.ts's findOpeningTagSpan) demanded a
 * literal `<tagName` string match within a small line window. That breaks the
 * instant a component wraps the rendered DOM node — e.g. source metadata
 * resolving to `<Button href="/contact">` in Hero.tsx (a component
 * invocation) while the clicked DOM element is the `<a>` that Button.tsx
 * renders internally. There is no literal `<a` near that line in Hero.tsx, so
 * the old locator failed outright with "Could not locate JSX element".
 *
 * This locator parses the file with Babel and reasons about JSX structurally:
 * it finds the real AST node at the reported line/column (whatever tag it
 * is — intrinsic or a custom component), and tells the caller which case it
 * is so the writer can branch (write directly onto an intrinsic tag, or
 * treat a capitalised tag as a component invocation needing a scope choice).
 * When the exact position doesn't resolve cleanly, it falls back to a ranked
 * search over increasing line windows, scoring candidates by tag/text/href/
 * class-list similarity — never a blind first-match.
 */
import * as fs from 'fs'
import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'
import type { NodePath } from '@babel/traverse'
import * as t from '@babel/types'

const traverse = ((_traverse as unknown) as { default: typeof _traverse }).default ?? _traverse

export interface LocateJsxParams {
  filePath: string
  sourceLine: number
  sourceCol?: number | null
  /** Rendered DOM tag name, lowercased, e.g. "a". */
  domTagName: string
  textContent?: string | null
  href?: string | null
  classList?: string[]
}

export interface JsxCandidate {
  /** The literal JSX tag as authored, e.g. "a" or "Button". */
  tagName: string
  /** True for a capitalised tag or member expression — a custom component invocation, not the intrinsic element. */
  isComponent: boolean
  line: number
  col: number
  confidence: number
  textPreview: string
  hrefPreview: string | null
  /** Byte offsets of the JSX opening tag itself (`<Tag ...>` / `<Tag .../>`). */
  tagStart: number
  tagEnd: number
  /**
   * True when this JSX node is inside a `.map()` callback — i.e. ONE source
   * node renders MANY DOM elements at runtime. Writing an unconditional style
   * or class here would affect every item, not just the one the user selected.
   */
  isMapped: boolean
  /**
   * Raw source text of the `data-hb-item-id={...}` expression found on this
   * element or an ancestor within the same `.map()` callback (e.g. "item.id").
   * Present only when isMapped is true and such an attribute could be found —
   * this is what lets a per-instance edit be scoped with `item.id === "..."`.
   */
  mapItemExpr?: string
}

export interface LocateJsxResult {
  success: boolean
  error?: string
  candidate?: JsxCandidate
  /** All candidates considered, ranked — always populated for logging and the "pick one" fallback UI. */
  candidates: JsxCandidate[]
  reason: string
}

function isComponentTag(name: string): boolean {
  return /[A-Z]/.test(name[0]) || name.includes('.')
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

/** Rendered text of a JSXElement's children, collapsed to a short preview. */
function extractJsxText(node: t.JSXElement | t.JSXFragment, depth = 0): string {
  if (depth > 5) return ''
  let out = ''
  for (const child of node.children) {
    if (t.isJSXText(child)) out += child.value
    else if (t.isJSXElement(child) || t.isJSXFragment(child)) out += extractJsxText(child, depth + 1)
    else if (t.isJSXExpressionContainer(child) && t.isStringLiteral(child.expression)) out += child.expression.value
  }
  return out.replace(/\s+/g, ' ').trim()
}

function literalHrefOf(opening: t.JSXOpeningElement): string | null {
  for (const attr of opening.attributes) {
    if (!t.isJSXAttribute(attr) || !t.isJSXIdentifier(attr.name, { name: 'href' })) continue
    if (t.isStringLiteral(attr.value)) return attr.value.value
    if (t.isJSXExpressionContainer(attr.value) && t.isStringLiteral(attr.value.expression)) return attr.value.expression.value
  }
  return null
}

function classListOf(opening: t.JSXOpeningElement): string[] {
  for (const attr of opening.attributes) {
    if (!t.isJSXAttribute(attr) || !t.isJSXIdentifier(attr.name, { name: 'className' })) continue
    if (t.isStringLiteral(attr.value)) return attr.value.value.split(/\s+/).filter(Boolean)
    if (t.isJSXExpressionContainer(attr.value) && t.isStringLiteral(attr.value.expression)) {
      return attr.value.expression.value.split(/\s+/).filter(Boolean)
    }
  }
  return []
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Walk up from a JSXOpeningElement to see whether it lives inside a
 * `.map(item => ...)` callback — meaning this ONE source node is the template
 * for MANY rendered DOM elements. Returns the callback function's path too,
 * so callers can bound an ancestor search for a `data-hb-item-id` attribute
 * to "within this same map callback" (not some unrelated outer map).
 */
function findMapContext(path: NodePath<t.JSXOpeningElement>): { isMapped: boolean; mapFuncPath?: NodePath } {
  const funcParent = path.getFunctionParent()
  if (!funcParent) return { isMapped: false }
  const callPath = funcParent.parentPath
  if (
    callPath?.isCallExpression() &&
    t.isMemberExpression(callPath.node.callee) &&
    t.isIdentifier(callPath.node.callee.property) &&
    callPath.node.callee.property.name === 'map'
  ) {
    return { isMapped: true, mapFuncPath: funcParent }
  }
  return { isMapped: false }
}

/**
 * Find a `data-hb-item-id={expr}` attribute on this element or an ancestor
 * JSX element, without leaving the bounding `.map()` callback. Returns the
 * raw source text of `expr` (e.g. "item.id") — not a re-generated string —
 * so it's guaranteed to compile identically to however the template already
 * identifies each item.
 */
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

interface RawCandidate {
  path: NodePath<t.JSXOpeningElement>
  opening: t.JSXOpeningElement
  tagName: string
  line: number
  col: number
}

function collectAll(ast: t.File): RawCandidate[] {
  const out: RawCandidate[] = []
  traverse(ast, {
    JSXOpeningElement(path) {
      const loc = path.node.loc
      if (!loc) return
      out.push({
        path,
        opening: path.node,
        tagName: jsxTagName(path.node.name),
        line: loc.start.line,
        col: loc.start.column + 1,
      })
    },
  })
  return out
}

function toCandidate(raw: RawCandidate, confidence: number, content: string): JsxCandidate {
  const parentElement = raw.path.parentPath.isJSXElement() ? raw.path.parentPath.node : null
  const mapContext = findMapContext(raw.path)
  const mapItemExpr = mapContext.isMapped && mapContext.mapFuncPath
    ? findMapItemExpr(raw.path, mapContext.mapFuncPath, content)
    : undefined
  return {
    tagName: raw.tagName,
    isComponent: isComponentTag(raw.tagName),
    line: raw.line,
    col: raw.col,
    confidence: Math.round(Math.max(0, Math.min(100, confidence))),
    textPreview: parentElement ? extractJsxText(parentElement).slice(0, 60) : '',
    hrefPreview: literalHrefOf(raw.opening),
    tagStart: raw.opening.start ?? -1,
    tagEnd: raw.opening.end ?? -1,
    isMapped: mapContext.isMapped,
    mapItemExpr,
  }
}

function scoreCandidate(raw: RawCandidate, dist: number, params: LocateJsxParams): number {
  let score = 0

  if (dist === 0) score += 50
  else if (dist <= 10) score += Math.max(0, 30 - dist * 2)
  else if (dist <= 50) score += Math.max(0, 15 - dist * 0.3)

  const tagLower = raw.tagName.toLowerCase()
  if (!isComponentTag(raw.tagName) && tagLower === params.domTagName.toLowerCase()) score += 20

  const parentElement = raw.path.parentPath.isJSXElement() ? raw.path.parentPath.node : null
  if (parentElement && params.textContent) {
    const text = normalize(extractJsxText(parentElement))
    const wanted = normalize(params.textContent)
    if (wanted && text && (text === wanted || text.includes(wanted) || wanted.includes(text))) score += 15
  }

  const href = literalHrefOf(raw.opening)
  if (href && params.href && href === params.href) score += 15

  if (params.classList?.length) {
    const candidateClasses = new Set(classListOf(raw.opening))
    const overlap = params.classList.filter((c) => candidateClasses.has(c)).length
    score += Math.min(10, overlap * 2)
  }

  return score
}

/**
 * Locate the JSX opening element a DOM node was rendered from.
 *
 * Search order: exact line (any tag — intrinsic or component, picking the
 * column-closest one if several share the line) → ±10 lines → ±50 lines →
 * whole file, each tier scored by tag/text/href/class similarity. Returns
 * every candidate considered (for logging + the "pick one" fallback UI), not
 * just the winner.
 */
/** Find the exact JSXOpeningElement AST node at a known line (+ optional column tiebreak). */
export function findJsxOpeningElementAt(content: string, line: number, col?: number | null): t.JSXOpeningElement | null {
  const ast = parseSource(content)
  if (!ast) return null
  const onLine = collectAll(ast).filter((c) => c.line === line)
  if (onLine.length === 0) return null
  const best = col != null
    ? onLine.reduce((a, b) => (Math.abs(a.col - col) <= Math.abs(b.col - col) ? a : b))
    : onLine[0]
  return best.opening
}

export function locateJsx(params: LocateJsxParams): LocateJsxResult {
  let content: string
  try {
    content = fs.readFileSync(params.filePath, 'utf-8')
  } catch (err) {
    return { success: false, error: `Cannot read ${params.filePath}: ${String(err)}`, candidates: [], reason: 'read-failed' }
  }

  const ast = parseSource(content)
  if (!ast) {
    return { success: false, error: `${params.filePath} could not be parsed (syntax error?)`, candidates: [], reason: 'parse-failed' }
  }

  const all = collectAll(ast)

  // ── Tier 0: exact line — accept ANY tag here (component or intrinsic). ──
  const onLine = all.filter((c) => c.line === params.sourceLine)
  if (onLine.length > 0) {
    const best = params.sourceCol != null
      ? onLine.reduce((a, b) => (Math.abs(a.col - params.sourceCol!) <= Math.abs(b.col - params.sourceCol!) ? a : b))
      : onLine[0]
    const candidate = toCandidate(best, 100, content)
    const allCandidates = all
      .map((c) => toCandidate(c, scoreCandidate(c, Math.abs(c.line - params.sourceLine), params), content))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 8)
    return {
      success: true,
      candidate,
      candidates: [candidate, ...allCandidates.filter((c) => c.tagStart !== candidate.tagStart)].slice(0, 8),
      reason: `Exact match at line ${params.sourceLine}: <${candidate.tagName}>`,
    }
  }

  // ── Tiers 1–3: widen the window, score by similarity. ──────────────────
  for (const radius of [10, 50, Infinity]) {
    const nearby = all.filter((c) => Math.abs(c.line - params.sourceLine) <= radius)
    if (nearby.length === 0) continue

    const scored = nearby
      .map((c) => ({ raw: c, score: scoreCandidate(c, Math.abs(c.line - params.sourceLine), params) }))
      .sort((a, b) => b.score - a.score)

    const top = scored[0]
    const candidates = scored.slice(0, 8).map((s) => toCandidate(s.raw, s.score, content))

    if (top.score >= 45) {
      return {
        success: true,
        candidate: candidates[0],
        candidates,
        reason: `Ranked match within ${radius === Infinity ? 'the whole file' : `±${radius} lines`} (confidence ${Math.round(top.score)})`,
      }
    }

    if (radius === Infinity) {
      return {
        success: false,
        error: `No confident JSX match for line ${params.sourceLine} in ${params.filePath} — best guess was <${top.raw.tagName}> at line ${top.raw.line} (confidence ${Math.round(top.score)})`,
        candidates,
        reason: 'low-confidence',
      }
    }
  }

  return {
    success: false,
    error: `No JSX elements found in ${params.filePath}`,
    candidates: [],
    reason: 'no-candidates',
  }
}
