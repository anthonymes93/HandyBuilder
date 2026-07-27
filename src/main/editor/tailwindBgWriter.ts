/**
 * Dedicated writer for Tailwind arbitrary-value background utilities, e.g.
 * `className="bg-[url('/images/service-area.jpg')]"`.
 *
 * These never go through writeInlineStyle (they aren't a `style={{}}` prop)
 * nor writeElementStyle's Tailwind reconciler (which only strips recognised
 * utilities, it doesn't rewrite arbitrary-value ones). Locate the exact JSX
 * element by line + tag, find the `bg-[url(...)]` token in its className,
 * and replace the URL inside the parens — the rest of the class list is
 * left untouched.
 */
import * as t from '@babel/types'
import { applySourceTransaction, MutateOutcome, HistoryEditType, HistoryElementMeta } from './sourceTransaction'
import { findJsxOpeningElementAt } from './jsxLocator'

export interface WriteTailwindBgUrlParams {
  filePath: string
  lineNumber: number
  colNumber?: number | null
  tagName?: string
  newUrl: string
  projectPath: string
  description: string
  editType: HistoryEditType
  element?: HistoryElementMeta
}

export interface WriteTailwindBgUrlResult {
  success: boolean
  filePath?: string
  lineNumber?: number
  error?: string
  historyRecorded?: boolean
  skippedReason?: string
}

const BG_URL_TOKEN = /bg-\[url\((['"]?)([^)'"]+)\1\)\]/

function computeTailwindBgUrl(content: string, params: WriteTailwindBgUrlParams): MutateOutcome {
  const opening = findJsxOpeningElementAt(content, params.lineNumber, params.colNumber)
  if (!opening || opening.start == null || opening.end == null) {
    return { success: false, error: `Could not locate JSX element near ${params.filePath}:${params.lineNumber}` }
  }

  const attr = opening.attributes.find(
    (a): a is t.JSXAttribute => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name, { name: 'className' })
  )
  if (!attr || !attr.value) {
    return { success: false, error: 'This element has no className attribute to update.' }
  }

  const value = attr.value
  let literalStart: number, literalEnd: number, literalText: string
  if (t.isStringLiteral(value) && value.start != null && value.end != null) {
    literalStart = value.start + 1
    literalEnd = value.end - 1
    literalText = value.value
  } else if (
    t.isJSXExpressionContainer(value) && t.isStringLiteral(value.expression) &&
    value.expression.start != null && value.expression.end != null
  ) {
    literalStart = value.expression.start + 1
    literalEnd = value.expression.end - 1
    literalText = value.expression.value
  } else {
    return {
      success: false,
      error: "This element's className is a dynamic expression — HandyBuilder can't safely locate the bg-[url(...)] token in it. No changes were made.",
    }
  }

  const match = BG_URL_TOKEN.exec(literalText)
  if (!match) {
    return { success: false, error: 'No bg-[url(...)] utility found in this className.' }
  }

  const writtenLine = content.slice(0, opening.start).split('\n').length

  const quote = match[1] || "'"
  const newToken = `bg-[url(${quote}${params.newUrl}${quote})]`
  const newLiteralText = literalText.slice(0, match.index) + newToken + literalText.slice(match.index + match[0].length)

  if (newLiteralText === literalText) {
    return { success: true, lineNumber: writtenLine } // no-op
  }

  const newContent = content.slice(0, literalStart) + newLiteralText + content.slice(literalEnd)
  return { success: true, newContent, lineNumber: writtenLine }
}

export function writeTailwindBgUrl(params: WriteTailwindBgUrlParams): WriteTailwindBgUrlResult {
  const result = applySourceTransaction({
    projectPath: params.projectPath,
    filePath: params.filePath,
    description: params.description,
    editType: params.editType,
    sourceLine: params.lineNumber,
    element: params.element,
    mutate: (content) => computeTailwindBgUrl(content, params),
  })
  if (result.success && result.historyRecorded) {
    console.log(`[tailwindBgWriter] wrote bg-[url()] to ${params.filePath}:${result.lineNumber}`)
  }
  return result
}
