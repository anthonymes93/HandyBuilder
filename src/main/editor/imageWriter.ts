/**
 * Dedicated writer for <img> attribute edits (src, alt, width, height).
 *
 * An <img>'s src/alt never appear as visible page text, so the fuzzy
 * text-search pipeline (analyzeLocatedEdit / analyzeTextEdit / astLocateBinding,
 * all keyed off the element's rendered textContent) can never reliably locate
 * them — for a plain <img> it has nothing to search for and reports "text not
 * found". This writer instead parses the source file with Babel, locates the
 * exact JSX element by line number + tag name, and replaces the attribute
 * value spans directly — no text search involved.
 */

import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'
import * as t from '@babel/types'
import { applySourceTransaction, MutateOutcome, HistoryEditType, HistoryElementMeta } from './sourceTransaction'

// CJS/ESM interop — electron-vite externalises deps so they arrive as CJS
const traverse = ((_traverse as unknown) as { default: typeof _traverse }).default ?? _traverse

export interface WriteImageAttrsParams {
  filePath: string
  lineNumber: number
  tagName?: string
  src?: string
  alt?: string
  width?: string
  height?: string
  projectPath: string
  description: string
  editType: HistoryEditType
  element?: HistoryElementMeta
}

export interface WriteImageAttrsResult {
  success: boolean
  filePath?: string
  lineNumber?: number
  updatedAttrs?: string[]
  error?: string
  historyRecorded?: boolean
  skippedReason?: string
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

/** Find the JSXOpeningElement nearest to targetLine, preferring an exact tag-name match. */
function findOpeningElement(
  ast: t.File,
  targetLine: number,
  tagHint?: string
): t.JSXOpeningElement | null {
  const candidates: Array<{ node: t.JSXOpeningElement; dist: number; tagMatch: boolean }> = []

  traverse(ast, {
    JSXOpeningElement(path) {
      const loc = path.node.loc?.start
      if (!loc) return
      const dist = Math.abs(loc.line - targetLine)
      if (dist > 20) return
      const nameNode = path.node.name
      const tag = t.isJSXIdentifier(nameNode) ? nameNode.name : undefined
      candidates.push({ node: path.node, dist, tagMatch: tagHint ? tag === tagHint : true })
    },
  })

  if (candidates.length === 0) return null

  candidates.sort((a, b) => {
    if (a.tagMatch !== b.tagMatch) return a.tagMatch ? -1 : 1
    return a.dist - b.dist
  })

  return candidates[0].node
}

function quoteLiteral(value: string): string {
  return JSON.stringify(value)
}

type ImageAttrOutcome = MutateOutcome & { updatedAttrs: string[] }

function computeImageAttrs(
  content: string,
  filePath: string,
  lineNumber: number,
  tagName: string | undefined,
  wanted: Array<['src' | 'alt' | 'width' | 'height', string]>
): ImageAttrOutcome {
  const ast = parseSource(content)
  if (!ast) {
    return { success: false, error: `${filePath} could not be parsed (syntax error?)`, updatedAttrs: [] }
  }

  const opening = findOpeningElement(ast, lineNumber, tagName)
  if (!opening) {
    return { success: false, error: `No JSX element found near ${filePath}:${lineNumber}`, updatedAttrs: [] }
  }

  type Splice = { start: number; end: number; text: string }
  const splices: Splice[] = []
  const updatedAttrs: string[] = []
  const toInsert: string[] = []

  for (const [attrName, value] of wanted) {
    const existing = opening.attributes.find(
      (a): a is t.JSXAttribute =>
        t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === attrName
    )

    if (existing) {
      if (existing.value && existing.value.start != null && existing.value.end != null) {
        splices.push({ start: existing.value.start, end: existing.value.end, text: quoteLiteral(value) })
        updatedAttrs.push(attrName)
      } else if (existing.name.end != null) {
        // Boolean attribute (no value, e.g. bare `alt`) — give it one.
        splices.push({ start: existing.name.end, end: existing.name.end, text: `=${quoteLiteral(value)}` })
        updatedAttrs.push(attrName)
      }
    } else {
      toInsert.push(`${attrName}=${quoteLiteral(value)}`)
      updatedAttrs.push(attrName)
    }
  }

  if (toInsert.length > 0) {
    const attrs = opening.attributes
    const insertAt = attrs.length > 0 ? attrs[attrs.length - 1].end : opening.name.end
    if (insertAt == null) {
      return { success: false, error: 'Could not determine attribute insertion point', updatedAttrs: [] }
    }
    splices.push({ start: insertAt, end: insertAt, text: ` ${toInsert.join(' ')}` })
  }

  const writtenLine = content.slice(0, opening.start ?? 0).split('\n').length

  if (splices.length === 0) {
    return { success: true, lineNumber: writtenLine, updatedAttrs: [] } // nothing changed — no-op
  }

  // Apply from the end of the file backward so earlier offsets stay valid.
  splices.sort((a, b) => b.start - a.start)
  let newContent = content
  for (const { start, end, text } of splices) {
    newContent = newContent.slice(0, start) + text + newContent.slice(end)
  }

  return { success: true, newContent, lineNumber: writtenLine, updatedAttrs }
}

/**
 * Locate an <img> (or other tag) opening element by source line + tag name,
 * then add/replace its src/alt/width/height attributes with literal string
 * values.
 *
 * Works whether the current attribute is a string literal (`src="..."`) or a
 * JSX expression (`src={heroImage}`) — the entire attribute *value* span is
 * replaced, so an imported/shared variable referenced elsewhere is never
 * touched; only this one JSX attribute stops referencing it.
 */
export function writeImageAttrs(params: WriteImageAttrsParams): WriteImageAttrsResult {
  const { filePath, lineNumber, tagName } = params

  const wanted: Array<['src' | 'alt' | 'width' | 'height', string]> = (
    [
      ['src', params.src],
      ['alt', params.alt],
      ['width', params.width],
      ['height', params.height],
    ] as const
  ).filter((pair): pair is ['src' | 'alt' | 'width' | 'height', string] => pair[1] !== undefined)

  if (wanted.length === 0) {
    return { success: true, filePath, lineNumber }
  }

  let updatedAttrs: string[] = []

  const result = applySourceTransaction({
    projectPath: params.projectPath,
    filePath,
    description: params.description,
    editType: params.editType,
    sourceLine: lineNumber,
    element: params.element,
    mutate: (content) => {
      const outcome = computeImageAttrs(content, filePath, lineNumber, tagName, wanted)
      updatedAttrs = outcome.updatedAttrs
      return outcome
    },
  })

  if (!result.success) {
    return { success: false, error: result.error }
  }

  if (result.historyRecorded) {
    console.log(`[imageWriter] wrote image attrs [${updatedAttrs.join(', ')}] to ${filePath}:${result.lineNumber}`)
  }

  return {
    success: true,
    filePath: result.filePath,
    lineNumber: result.lineNumber,
    updatedAttrs,
    historyRecorded: result.historyRecorded,
    skippedReason: result.skippedReason,
  }
}
