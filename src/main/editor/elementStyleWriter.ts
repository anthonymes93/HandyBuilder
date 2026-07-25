/**
 * Orchestrates a single visual-editor Save for a button/text element:
 *
 *  1. Locate the real JSX element (jsxLocator.ts — AST-based, tolerant of
 *     component indirection; see that module's header for why the old
 *     line+tag-string search broke on `<Button href="/contact">` wrapping an
 *     `<a>`).
 *  2. If the located node is a custom component invocation (not the intrinsic
 *     tag itself) and the caller hasn't chosen a scope yet, stop and report
 *     `needsScopeChoice` — the renderer asks "this button only" vs "all
 *     buttons using X" before anything is written.
 *  3. Reconcile recognised Tailwind utilities for the properties being set,
 *     then merge normal-state properties into style={{}} (never deleting
 *     unrelated values).
 *  4. If hover properties are present, attach a stable `hb-style-<id>` class
 *     (tolerating a literal className, a cn()/clsx()-style merge call, or no
 *     className at all) and write/merge the `:hover` rule into a shared
 *     project stylesheet, ensuring the component file imports it once.
 *
 * All of this — component file edit + stylesheet edit — is written as ONE
 * atomic multi-file transaction, so it becomes exactly one Undo/Redo step.
 */
import * as fs from 'fs'
import * as t from '@babel/types'
import {
  findStylePropSpan, parseStyleBody, buildStyleAttr, findInsertionPoint,
} from './styleWriter'
import { stripRecognizedTailwind } from './tailwindReconcile'
import {
  computeStyleId, hoverStylesheetPath, stylesheetImportSpecifier,
  computeHoverStylesheetMutation, computeStylesheetImportMutation,
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
  /** camelCase CSS prop → value. Empty string removes the property. */
  normalStyleProps: Record<string, string>
  /** camelCase CSS prop → value, written to `.hb-style-<id>:hover`. */
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
  /** False when hover props were requested but couldn't be attached (e.g. dynamic className). */
  hoverPersisted?: boolean
  hoverWarning?: string
  styleId?: string
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
  | { mode: 'literal'; absStart: number; absEnd: number; value: string }
  | { mode: 'call'; absInsertBeforeParen: number }
  | { mode: 'dynamic' }
  | { mode: 'absent' }

function detectClassNameMode(opening: t.JSXOpeningElement): ClassNameMode {
  const attr = opening.attributes.find(
    (a): a is t.JSXAttribute => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name, { name: 'className' })
  )
  if (!attr) return { mode: 'absent' }

  const value = attr.value
  if (t.isStringLiteral(value) && value.start != null && value.end != null) {
    return { mode: 'literal', absStart: value.start + 1, absEnd: value.end - 1, value: value.value }
  }
  if (t.isJSXExpressionContainer(value)) {
    const expr = value.expression
    if (t.isStringLiteral(expr) && expr.start != null && expr.end != null) {
      return { mode: 'literal', absStart: expr.start + 1, absEnd: expr.end - 1, value: expr.value }
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
  normalStyleProps: Record<string, string>
  styleId: string
  attachHoverClass: boolean
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

  // ── className: reconcile Tailwind + attach the stable hover hook class ──
  const classMode = detectClassNameMode(opening)
  const changingProps = Object.keys(opts.normalStyleProps)

  if (classMode.mode === 'literal') {
    let nextClassName = stripRecognizedTailwind(classMode.value, changingProps)
    const hasHookClass = new RegExp(`(^|\\s)hb-style-${opts.styleId}(\\s|$)`).test(nextClassName)
    if (opts.attachHoverClass && !hasHookClass) {
      nextClassName = `${nextClassName} hb-style-${opts.styleId}`.trim()
    }
    if (nextClassName !== classMode.value) {
      const relStart = classMode.absStart - tagStart
      const relEnd = classMode.absEnd - tagStart
      tagContent = tagContent.slice(0, relStart) + nextClassName + tagContent.slice(relEnd)
    }
  } else if (classMode.mode === 'call' && opts.attachHoverClass) {
    // className={cn("...", className)} → className={cn("...", className, "hb-style-x")}
    const relInsert = classMode.absInsertBeforeParen - tagStart
    if (!tagContent.includes(`hb-style-${opts.styleId}`)) {
      tagContent = tagContent.slice(0, relInsert) + `, "hb-style-${opts.styleId}"` + tagContent.slice(relInsert)
    }
  } else if (classMode.mode === 'absent' && opts.attachHoverClass) {
    const insertAt = findInsertionPoint(tagContent)
    if (insertAt === -1) return { success: false, error: 'Could not find closing bracket to insert className' }
    tagContent = tagContent.slice(0, insertAt) + ` className="hb-style-${opts.styleId}"` + tagContent.slice(insertAt)
  }
  // 'dynamic' mode: className is left completely untouched — hover class can't be safely attached.

  // ── style={{}}: merge normal-state properties only — hover lives in the stylesheet ──
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
    filePath, lineNumber, colNumber, tagName, textContent, href, classList,
    normalStyleProps, hoverStyleProps, projectPath, description, element,
    editScope, scopeFilePath, scopeLine,
  } = params

  const wantsHover = !!hoverStyleProps && Object.keys(hoverStyleProps).length > 0

  let targetFilePath = filePath
  let targetLine = lineNumber
  let targetCol: number | null | undefined = colNumber
  let sharedComponentWarning: string | undefined

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
  }

  const styleId = computeStyleId(targetFilePath, targetLine)

  // Pre-pass: can this element's className safely carry a stable hook class?
  let canPersistHover = true
  let hoverWarning: string | undefined

  if (wantsHover) {
    try {
      const content = fs.readFileSync(targetFilePath, 'utf-8')
      const opening = findJsxOpeningElementAt(content, targetLine, targetCol)
      if (opening) {
        const mode = detectClassNameMode(opening)
        if (mode.mode === 'dynamic') {
          canPersistHover = false
          hoverWarning = "This element's className is a dynamic expression HandyBuilder can't safely merge into — hover styles could not be attached. Normal styles were still saved."
        }
      } else {
        canPersistHover = false
        hoverWarning = `Could not locate the JSX element at ${targetFilePath}:${targetLine} to attach hover styles.`
      }
    } catch (err) {
      canPersistHover = false
      hoverWarning = `Could not read ${targetFilePath} to check className — hover styles were not saved: ${String(err)}`
    }
  }

  const files: FileMutation[] = [
    {
      filePath: targetFilePath,
      mutate: (content) => mutateComponentFile(content, {
        targetLine,
        targetCol,
        normalStyleProps,
        styleId,
        attachHoverClass: wantsHover && canPersistHover,
        stylesheetImportSpecifier: wantsHover && canPersistHover
          ? stylesheetImportSpecifier(targetFilePath, hoverStylesheetPath(projectPath))
          : undefined,
      }),
    },
  ]

  if (wantsHover && canPersistHover) {
    files.push({
      filePath: hoverStylesheetPath(projectPath),
      mutate: (content) => computeHoverStylesheetMutation(content, styleId, hoverStyleProps!),
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
    hoverPersisted: wantsHover ? canPersistHover : undefined,
    hoverWarning,
    styleId,
    sharedComponentWarning,
  }
}
