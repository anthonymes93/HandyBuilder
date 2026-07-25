/**
 * Orchestrates a single visual-editor Save for a button/text element:
 *
 *  1. Locate the JSX opening tag by source line (+tag hint), same as writeInlineStyle.
 *  2. Reconcile recognised Tailwind utilities for the properties being set,
 *     then merge normal-state properties into style={{}} (never deleting
 *     unrelated values).
 *  3. If hover properties are present and the element's className is a plain
 *     string literal (not a dynamic expression), attach a stable
 *     `hb-style-<id>` class and write/merge the `:hover` rule into a shared
 *     project stylesheet, ensuring the component file imports it once.
 *
 * All of this — component file edit + stylesheet edit — is written as ONE
 * atomic multi-file transaction, so it becomes exactly one Undo/Redo step.
 */
import * as fs from 'fs'
import {
  findOpeningTagSpan, findStylePropSpan, parseStyleBody, buildStyleAttr, findInsertionPoint,
} from './styleWriter'
import { stripRecognizedTailwind } from './tailwindReconcile'
import {
  computeStyleId, hoverStylesheetPath, stylesheetImportSpecifier,
  computeHoverStylesheetMutation, computeStylesheetImportMutation,
} from './hoverStylesheet'
import {
  applySourceTransactionMulti, FileMutation, MutateOutcome, HistoryElementMeta,
} from './sourceTransaction'

export interface WriteElementStyleParams {
  filePath: string
  lineNumber: number
  tagName?: string
  /** camelCase CSS prop → value. Empty string removes the property. */
  normalStyleProps: Record<string, string>
  /** camelCase CSS prop → value, written to `.hb-style-<id>:hover`. */
  hoverStyleProps?: Record<string, string>
  projectPath: string
  description: string
  element?: HistoryElementMeta
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
}

type ClassNameMode =
  | { mode: 'literal'; value: string; span: { start: number; end: number } }
  | { mode: 'dynamic' }
  | { mode: 'absent' }

/** Inspect a JSX opening tag's className attribute without mutating anything. */
function detectClassNameMode(tagContent: string): ClassNameMode {
  // className="literal value"
  let m = /\bclassName\s*=\s*"([^"]*)"/.exec(tagContent)
  if (m) {
    const valueStart = m.index + m[0].indexOf('"') + 1
    return { mode: 'literal', value: m[1], span: { start: valueStart, end: valueStart + m[1].length } }
  }
  // className={'literal'} / className={"literal"}
  m = /\bclassName\s*=\s*\{\s*(['"])([^'"]*)\1\s*\}/.exec(tagContent)
  if (m) {
    const quoteChar = m[1]
    const quoteIdx = tagContent.indexOf(quoteChar, m.index)
    const valueStart = quoteIdx + 1
    return { mode: 'literal', value: m[2], span: { start: valueStart, end: valueStart + m[2].length } }
  }
  // Any other className={...} — a dynamic expression (clsx(...), ternary, identifier…). Don't touch it.
  if (/\bclassName\s*=\s*\{/.test(tagContent)) return { mode: 'dynamic' }
  return { mode: 'absent' }
}

interface MutateComponentOpts {
  lineNumber: number
  tagName?: string
  normalStyleProps: Record<string, string>
  styleId: string
  attachHoverClass: boolean
  stylesheetImportSpecifier?: string
}

function mutateComponentFile(content: string, opts: MutateComponentOpts): MutateOutcome {
  const tagSpan = findOpeningTagSpan(content, opts.lineNumber, opts.tagName)
  if (!tagSpan) {
    return { success: false, error: `Could not locate JSX element near line ${opts.lineNumber}` }
  }

  let tagContent = content.slice(tagSpan.start, tagSpan.end)

  // ── className: reconcile Tailwind + attach the stable hover hook class ──
  const classMode = detectClassNameMode(tagContent)
  const changingProps = Object.keys(opts.normalStyleProps)

  if (classMode.mode === 'literal') {
    let nextClassName = stripRecognizedTailwind(classMode.value, changingProps)
    const hasHookClass = new RegExp(`(^|\\s)hb-style-${opts.styleId}(\\s|$)`).test(nextClassName)
    if (opts.attachHoverClass && !hasHookClass) {
      nextClassName = `${nextClassName} hb-style-${opts.styleId}`.trim()
    }
    if (nextClassName !== classMode.value) {
      tagContent = tagContent.slice(0, classMode.span.start) + nextClassName + tagContent.slice(classMode.span.end)
    }
  } else if (classMode.mode === 'absent' && opts.attachHoverClass) {
    const insertAt = findInsertionPoint(tagContent)
    if (insertAt === -1) return { success: false, error: 'Could not find closing bracket to insert className' }
    tagContent = tagContent.slice(0, insertAt) + ` className="hb-style-${opts.styleId}"` + tagContent.slice(insertAt)
  }
  // 'dynamic' mode: className is left completely untouched.

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

  let newContent = content.slice(0, tagSpan.start) + tagContent + content.slice(tagSpan.end)

  if (opts.stylesheetImportSpecifier) {
    const importOutcome = computeStylesheetImportMutation(newContent, opts.stylesheetImportSpecifier)
    if (importOutcome.success && importOutcome.newContent !== undefined) {
      newContent = importOutcome.newContent
    }
  }

  const writtenLine = content.slice(0, tagSpan.start).split('\n').length
  if (newContent === content) return { success: true, lineNumber: writtenLine } // no-op
  return { success: true, newContent, lineNumber: writtenLine }
}

export function writeElementStyle(params: WriteElementStyleParams): WriteElementStyleResult {
  const { filePath, lineNumber, tagName, normalStyleProps, hoverStyleProps, projectPath, description, element } = params
  const styleId = computeStyleId(filePath, lineNumber)
  const wantsHover = !!hoverStyleProps && Object.keys(hoverStyleProps).length > 0

  // Pre-pass: can this element's className safely carry a stable hook class?
  let canPersistHover = true
  let hoverWarning: string | undefined

  if (wantsHover) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const tagSpan = findOpeningTagSpan(content, lineNumber, tagName)
      if (tagSpan) {
        const mode = detectClassNameMode(content.slice(tagSpan.start, tagSpan.end))
        if (mode.mode === 'dynamic') {
          canPersistHover = false
          hoverWarning = "This element's className is a dynamic expression — hover styles could not be attached. Normal styles were still saved."
        }
      }
    } catch (err) {
      canPersistHover = false
      hoverWarning = `Could not read ${filePath} to check className — hover styles were not saved: ${String(err)}`
    }
  }

  const files: FileMutation[] = [
    {
      filePath,
      mutate: (content) => mutateComponentFile(content, {
        lineNumber,
        tagName,
        normalStyleProps,
        styleId,
        attachHoverClass: wantsHover && canPersistHover,
        stylesheetImportSpecifier: wantsHover && canPersistHover
          ? stylesheetImportSpecifier(filePath, hoverStylesheetPath(projectPath))
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
    sourceLine: lineNumber,
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
  }
}
