/**
 * Orchestrates a single visual-editor Save for a button/text element:
 *
 *  1. Locate the real JSX element (jsxLocator.ts — AST-based, tolerant of
 *     component indirection and aware of `.map()` templates).
 *  2. If the located node is a custom component invocation and the caller
 *     hasn't chosen a scope yet, stop and report `needsScopeChoice` — the
 *     renderer asks "this button only" vs "all buttons using X" first.
 *  3. If "this button only" targets a node inside a `.map()` template (one
 *     JSX node renders MANY DOM elements), an unconditional class/style edit
 *     would affect every item. Instead we scope the class to the exact
 *     selected item via `data-hb-item-id`'s own expression (e.g.
 *     `item.id === "apex-roofing" && "hb-instance-x"`), and route ALL
 *     styling (normal + hover) through that class — inline `style` can't be
 *     conditionally scoped per iteration, so it's never used for mapped
 *     instances. If no per-item condition can be established, the save is
 *     refused outright rather than silently touching every item.
 *  4. For non-mapped instance/shared edits: reconcile recognised Tailwind
 *     utilities, merge normal-state properties into style={{}}, and (for
 *     hover) attach a stable class + write/merge a `:hover` rule into the
 *     shared project stylesheet.
 *
 * All file edits for one Save — component file + optional stylesheet — land
 * in ONE atomic multi-file transaction, so it becomes exactly one Undo/Redo
 * step.
 */
import * as fs from 'fs'
import * as t from '@babel/types'
import {
  findStylePropSpan, parseStyleBody, buildStyleAttr, findInsertionPoint,
} from './styleWriter'
import { stripRecognizedTailwind } from './tailwindReconcile'
import {
  computeStyleId, hoverStylesheetPath, stylesheetImportSpecifier,
  computeScopedStylesheetMutation, computeStylesheetImportMutation,
} from './hoverStylesheet'
import {
  applySourceTransactionMulti, FileMutation, MutateOutcome, HistoryElementMeta,
} from './sourceTransaction'
import { locateJsx, findJsxOpeningElementAt, JsxCandidate } from './jsxLocator'
import { resolveComponentImport } from './componentResolver'

export interface WriteElementStyleParams {
  /** Source metadata as captured for the selected DOM element. */
  filePath: string
  lineNumber: number
  colNumber?: number | null
  tagName?: string
  textContent?: string | null
  href?: string | null
  classList?: string[]
  /** Current route — folded into the style-identity hash. */
  pathname?: string | null
  /** Mapped-array item identifier (data-hb-item-id), if this element is inside a `.map()`. */
  itemId?: string | null
  /** camelCase CSS prop → value. Empty string removes the property. */
  normalStyleProps: Record<string, string>
  /** camelCase CSS prop → value, written to the `:hover` rule. */
  hoverStyleProps?: Record<string, string>
  projectPath: string
  description: string
  element?: HistoryElementMeta
  /** Set once the user has answered the "this button only" vs "all buttons" prompt. */
  editScope?: 'instance' | 'shared'
  /** When editScope === 'shared', the resolved component-definition file + line from a prior needsScopeChoice response. */
  scopeFilePath?: string
  scopeLine?: number
}

export interface DiagnosticCandidate {
  tagName: string
  line: number
  col: number
  confidence: number
  textPreview: string
  hrefPreview: string | null
}

export interface WriteElementStyleResult {
  success: boolean
  filePath?: string
  lineNumber?: number
  error?: string
  historyRecorded?: boolean
  skippedReason?: string
  /** False when a hover/instance class was needed but couldn't be attached. */
  hoverPersisted?: boolean
  hoverWarning?: string
  styleId?: string
  /** The exact class written for this save (hb-instance-* or hb-style-*) — used by the caller to verify DOM isolation after reload. */
  appliedClassName?: string
  /** Present instead of success/failure when the located node is a component invocation and no scope has been chosen yet. Nothing was written. */
  needsScopeChoice?: {
    componentName: string
    instanceFilePath: string
    instanceLine: number
    sharedFilePath?: string
    sharedLine?: number
    sharedForwardsProps?: boolean
  }
  /** Populated on locator failure — ranked candidates for a "pick the right element" fallback UI. */
  diagnostics?: {
    reason: string
    candidates: DiagnosticCandidate[]
  }
  /** Set when writing directly into what looks like a shared component's own definition file. */
  sharedComponentWarning?: string
}

function toDiagCandidate(c: JsxCandidate): DiagnosticCandidate {
  return { tagName: c.tagName, line: c.line, col: c.col, confidence: c.confidence, textPreview: c.textPreview, hrefPreview: c.hrefPreview }
}

// ─── className handling (AST-based — tolerant of cn()/clsx() merge calls) ────

const CLASS_MERGE_FUNCS = new Set(['cn', 'clsx', 'classNames', 'classnames', 'cx'])

type ClassNameMode =
  | { mode: 'literal'; value: string; valueStart: number; valueEnd: number; attrStart: number; attrEnd: number }
  | { mode: 'call'; absInsertBeforeParen: number }
  | { mode: 'dynamic' }
  | { mode: 'absent' }

function detectClassNameMode(opening: t.JSXOpeningElement): ClassNameMode {
  const attr = opening.attributes.find(
    (a): a is t.JSXAttribute => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name, { name: 'className' })
  )
  if (!attr || attr.start == null || attr.end == null) return { mode: 'absent' }

  const value = attr.value
  if (t.isStringLiteral(value) && value.start != null && value.end != null) {
    return { mode: 'literal', value: value.value, valueStart: value.start + 1, valueEnd: value.end - 1, attrStart: attr.start, attrEnd: attr.end }
  }
  if (t.isJSXExpressionContainer(value)) {
    const expr = value.expression
    if (t.isStringLiteral(expr) && expr.start != null && expr.end != null) {
      return { mode: 'literal', value: expr.value, valueStart: expr.start + 1, valueEnd: expr.end - 1, attrStart: attr.start, attrEnd: attr.end }
    }
    if (
      t.isCallExpression(expr) && t.isIdentifier(expr.callee) &&
      CLASS_MERGE_FUNCS.has(expr.callee.name) && expr.end != null
    ) {
      return { mode: 'call', absInsertBeforeParen: expr.end - 1 }
    }
  }
  return { mode: 'dynamic' }
}

// ─── component file mutation ──────────────────────────────────────────────

interface MutateComponentOpts {
  targetLine: number
  targetCol?: number | null
  className: string
  normalStyleProps: Record<string, string>
  attachClass: boolean
  /** Set only for a mapped-template instance edit — scopes the class to one item. */
  conditional?: { mapItemExpr: string; itemId: string }
  stylesheetImportSpecifier?: string
}

function mutateComponentFile(content: string, opts: MutateComponentOpts): MutateOutcome {
  const opening = findJsxOpeningElementAt(content, opts.targetLine, opts.targetCol)
  if (!opening || opening.start == null || opening.end == null) {
    return { success: false, error: `Could not locate JSX element near line ${opts.targetLine}` }
  }

  const tagStart = opening.start
  const tagEnd = opening.end
  let tagContent = content.slice(tagStart, tagEnd)

  const classMode = detectClassNameMode(opening)
  const changingProps = Object.keys(opts.normalStyleProps)

  if (opts.conditional) {
    // ── Mapped template: NEVER touch the shared base classes — only ever ADD a
    // per-item conditional token, so unrelated items are provably unaffected. ──
    const { mapItemExpr, itemId } = opts.conditional
    const condition = `${mapItemExpr} === ${JSON.stringify(itemId)}`

    if (!opts.attachClass) {
      // Nothing to write this save (shouldn't normally happen — caller only sets attachClass=false when there's nothing to apply).
    } else if (classMode.mode === 'call') {
      const relInsert = classMode.absInsertBeforeParen - tagStart
      if (!tagContent.includes(opts.className)) {
        tagContent = tagContent.slice(0, relInsert) + `, ${condition} && ${JSON.stringify(opts.className)}` + tagContent.slice(relInsert)
      }
    } else if (classMode.mode === 'literal') {
      if (!classMode.value.split(/\s+/).includes(opts.className)) {
        const relAttrStart = classMode.attrStart - tagStart
        const relAttrEnd = classMode.attrEnd - tagStart
        const merged = `${classMode.value} ${opts.className}`.trim()
        const newAttr = `className={${condition} ? ${JSON.stringify(merged)} : ${JSON.stringify(classMode.value)}}`
        tagContent = tagContent.slice(0, relAttrStart) + newAttr + tagContent.slice(relAttrEnd)
      }
    } else if (classMode.mode === 'absent') {
      const insertAt = findInsertionPoint(tagContent)
      if (insertAt === -1) return { success: false, error: 'Could not find closing bracket to insert className' }
      tagContent = tagContent.slice(0, insertAt) + ` className={${condition} ? ${JSON.stringify(opts.className)} : undefined}` + tagContent.slice(insertAt)
    } else {
      return { success: false, error: "This element's className is a dynamic expression — HandyBuilder can't safely scope a per-item class into it. No changes were made." }
    }
  } else {
    // ── Non-mapped instance / shared edit: existing behaviour — reconcile
    // Tailwind utilities for the properties changing, optionally attach the
    // stable hook class unconditionally (this IS the one node for this instance). ──
    if (classMode.mode === 'literal') {
      let nextClassName = stripRecognizedTailwind(classMode.value, changingProps)
      const hasHookClass = new RegExp(`(^|\\s)${opts.className}(\\s|$)`).test(nextClassName)
      if (opts.attachClass && !hasHookClass) nextClassName = `${nextClassName} ${opts.className}`.trim()
      if (nextClassName !== classMode.value) {
        const relStart = classMode.valueStart - tagStart
        const relEnd = classMode.valueEnd - tagStart
        tagContent = tagContent.slice(0, relStart) + nextClassName + tagContent.slice(relEnd)
      }
    } else if (classMode.mode === 'call' && opts.attachClass) {
      const relInsert = classMode.absInsertBeforeParen - tagStart
      if (!tagContent.includes(opts.className)) {
        tagContent = tagContent.slice(0, relInsert) + `, ${JSON.stringify(opts.className)}` + tagContent.slice(relInsert)
      }
    } else if (classMode.mode === 'absent' && opts.attachClass) {
      const insertAt = findInsertionPoint(tagContent)
      if (insertAt === -1) return { success: false, error: 'Could not find closing bracket to insert className' }
      tagContent = tagContent.slice(0, insertAt) + ` className="${opts.className}"` + tagContent.slice(insertAt)
    }
    // 'dynamic' mode: className is left completely untouched.
  }

  // ── style={{}}: merge normal-state properties. Never used for mapped
  // instances (caller passes {} in that case — everything routes through the
  // conditional class + stylesheet instead, since inline style can't be
  // scoped to one iteration of a shared template). ──
  if (Object.keys(opts.normalStyleProps).length > 0) {
    const styleSpan = findStylePropSpan(tagContent)
    if (styleSpan) {
      const body = tagContent.slice(styleSpan.bodyStart, styleSpan.bodyEnd)
      const existing = parseStyleBody(body)
      for (const [k, v] of Object.entries(opts.normalStyleProps)) {
        if (v === '') existing.delete(k)
        else existing.set(k, v)
      }
      const newAttr = buildStyleAttr(existing)
      tagContent = tagContent.slice(0, styleSpan.propStart) + newAttr + tagContent.slice(styleSpan.propEnd)
    } else {
      const props = new Map<string, string>()
      for (const [k, v] of Object.entries(opts.normalStyleProps)) {
        if (v !== '') props.set(k, v)
      }
      if (props.size > 0) {
        const insertAt = findInsertionPoint(tagContent)
        if (insertAt === -1) return { success: false, error: 'Could not find closing bracket to insert style prop' }
        const newAttr = buildStyleAttr(props)
        tagContent = tagContent.slice(0, insertAt) + ' ' + newAttr + tagContent.slice(insertAt)
      }
    }
  }

  let newContent = content.slice(0, tagStart) + tagContent + content.slice(tagEnd)

  if (opts.stylesheetImportSpecifier) {
    const importOutcome = computeStylesheetImportMutation(newContent, opts.stylesheetImportSpecifier)
    if (importOutcome.success && importOutcome.newContent !== undefined) {
      newContent = importOutcome.newContent
    }
  }

  const writtenLine = content.slice(0, tagStart).split('\n').length
  if (newContent === content) return { success: true, lineNumber: writtenLine } // no-op
  return { success: true, newContent, lineNumber: writtenLine }
}

// ─── main entry point ──────────────────────────────────────────────────────

export function writeElementStyle(params: WriteElementStyleParams): WriteElementStyleResult {
  const {
    filePath, lineNumber, colNumber, tagName, textContent, href, classList, pathname, itemId,
    normalStyleProps, hoverStyleProps, projectPath, description, element,
    editScope, scopeFilePath, scopeLine,
  } = params

  const wantsHover = !!hoverStyleProps && Object.keys(hoverStyleProps).length > 0

  let targetFilePath = filePath
  let targetLine = lineNumber
  let targetCol: number | null | undefined = colNumber
  let sharedComponentWarning: string | undefined
  let candidateForTarget: JsxCandidate | undefined

  if (editScope === 'shared' && scopeFilePath && scopeLine !== undefined) {
    targetFilePath = scopeFilePath
    targetLine = scopeLine
    targetCol = null
    sharedComponentWarning = 'Saved to the shared component definition — this affects every place it is used.'
  } else {
    const locateResult = locateJsx({
      filePath,
      sourceLine: lineNumber,
      sourceCol: colNumber,
      domTagName: tagName ?? '',
      textContent,
      href,
      classList,
    })

    if (!locateResult.success || !locateResult.candidate) {
      return {
        success: false,
        error: locateResult.error ?? 'Could not locate the JSX element for this component.',
        diagnostics: { reason: locateResult.reason, candidates: locateResult.candidates.map(toDiagCandidate) },
      }
    }

    if (locateResult.candidate.isComponent && editScope === undefined) {
      const resolved = resolveComponentImport(filePath, locateResult.candidate.tagName)
      return {
        success: false,
        needsScopeChoice: {
          componentName: locateResult.candidate.tagName,
          instanceFilePath: filePath,
          instanceLine: locateResult.candidate.line,
          sharedFilePath: resolved?.filePath,
          sharedLine: resolved?.rootLine,
          sharedForwardsProps: resolved?.forwardsProps,
        },
      }
    }

    targetLine = locateResult.candidate.line
    targetCol = locateResult.candidate.col
    candidateForTarget = locateResult.candidate
  }

  const isInstanceScope = editScope !== 'shared'
  const isMapped = !!candidateForTarget?.isMapped
  const mapItemExpr = candidateForTarget?.mapItemExpr

  // Mapped template + "this instance only": we MUST have a per-item condition,
  // or refuse outright — never fall back to an unconditional (all-items) write.
  if (isMapped && isInstanceScope && (!mapItemExpr || !itemId)) {
    return {
      success: false,
      error: 'This button is one of several rendered from the same template, and HandyBuilder could not determine which specific item you selected (no data-hb-item-id found). No changes were made — styling it would have affected every item.',
    }
  }

  const classPrefix = isInstanceScope ? 'hb-instance' : 'hb-style'
  const styleId = computeStyleId({
    file: targetFilePath,
    line: targetLine,
    column: targetCol,
    pathname,
    itemId: isMapped ? itemId : undefined,
    text: textContent,
    href,
  })
  const className = `${classPrefix}-${styleId}`

  // Pre-pass: can this element's className safely carry the stable class?
  let canPersistClass = true
  let classWarning: string | undefined
  try {
    const content = fs.readFileSync(targetFilePath, 'utf-8')
    const opening = findJsxOpeningElementAt(content, targetLine, targetCol)
    if (opening) {
      const mode = detectClassNameMode(opening)
      if (mode.mode === 'dynamic') {
        canPersistClass = false
        classWarning = "This element's className is a dynamic expression HandyBuilder can't safely merge into."
      }
    } else {
      canPersistClass = false
      classWarning = `Could not locate the JSX element at ${targetFilePath}:${targetLine}.`
    }
  } catch (err) {
    canPersistClass = false
    classWarning = `Could not read ${targetFilePath} to check className: ${String(err)}`
  }

  if (isMapped && isInstanceScope && !canPersistClass) {
    // Mapped items MUST use the class mechanism — no safe inline-style fallback
    // exists for one iteration of a shared template. Refuse rather than risk
    // silently affecting every item.
    return { success: false, error: classWarning ?? 'Could not safely scope this edit to one item. No changes were made.' }
  }

  const wantsAnyStyling = wantsHover || Object.keys(normalStyleProps).length > 0
  const needsClass = isMapped ? wantsAnyStyling : wantsHover
  const attachClass = needsClass && canPersistClass

  const files: FileMutation[] = [
    {
      filePath: targetFilePath,
      mutate: (content) => mutateComponentFile(content, {
        targetLine,
        targetCol,
        className,
        // Mapped instances route ALL styling through the stylesheet class —
        // inline style can't be scoped to one iteration of a shared template.
        normalStyleProps: isMapped ? {} : normalStyleProps,
        attachClass,
        conditional: isMapped ? { mapItemExpr: mapItemExpr!, itemId: itemId! } : undefined,
        stylesheetImportSpecifier: attachClass
          ? stylesheetImportSpecifier(targetFilePath, hoverStylesheetPath(projectPath))
          : undefined,
      }),
    },
  ]

  const stylesheetBaseProps = isMapped ? normalStyleProps : {}
  const stylesheetHoverProps = hoverStyleProps ?? {}
  if (attachClass && (Object.keys(stylesheetBaseProps).length > 0 || Object.keys(stylesheetHoverProps).length > 0)) {
    files.push({
      filePath: hoverStylesheetPath(projectPath),
      mutate: (content) => computeScopedStylesheetMutation(content, className, stylesheetBaseProps, stylesheetHoverProps),
    })
  }

  const result = applySourceTransactionMulti({
    projectPath,
    description,
    editType: 'style',
    sourceLine: targetLine,
    element,
    files,
  })

  if (!result.success) {
    return { success: false, error: result.error }
  }

  return {
    success: true,
    filePath: result.filePath,
    lineNumber: result.lineNumber,
    historyRecorded: result.historyRecorded,
    skippedReason: result.skippedReason,
    hoverPersisted: wantsHover ? canPersistClass : undefined,
    hoverWarning: wantsHover && !canPersistClass ? classWarning : undefined,
    styleId,
    appliedClassName: attachClass ? className : undefined,
    sharedComponentWarning,
  }
}
