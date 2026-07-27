/**
 * Dedicated writer for `background-image` declarations that live in a plain
 * CSS/PostCSS stylesheet — either on the element's own class or on its
 * `::before`/`::after` pseudo-element. The renderer resolves which stylesheet
 * rule owns the image via CSSOM in the bridge (inspectorBridge.ts,
 * findCssBackgroundRule) and hands this writer the rule's selector text and
 * the absolute source file path (recovered from Vite's dev-time
 * `data-vite-dev-id` attribute on the injected `<style>` tag — no custom
 * plugin required).
 *
 * Text-based, brace-counted edit (consistent with the rest of this codebase's
 * writers) rather than a full CSS parse: locate the rule by selector text,
 * find or insert its `background-image` declaration, replace only the url().
 * Refuses rather than guessing when the selector can't be confidently found.
 */
import { applySourceTransaction, MutateOutcome, HistoryEditType, HistoryElementMeta } from './sourceTransaction'

export interface WriteCssBackgroundImageParams {
  /** Absolute path to the .css file, resolved from data-vite-dev-id. */
  filePath: string
  /** CSSOM selectorText of the matched rule, e.g. ".service-area" or ".service-area::before". */
  selectorText: string
  newUrl: string
  projectPath: string
  description: string
  editType: HistoryEditType
  element?: HistoryElementMeta
}

export interface WriteCssBackgroundImageResult {
  success: boolean
  filePath?: string
  lineNumber?: number
  error?: string
  historyRecorded?: boolean
  skippedReason?: string
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Match the selector as authored, tolerating whitespace variance and `:before`/`::before` spelling. */
function buildSelectorRegex(selectorText: string): RegExp {
  const normalized = selectorText.trim().replace(/\s+/g, ' ')
  const pseudoMatch = normalized.match(/^(.*?)\s*::?(before|after)$/)
  if (pseudoMatch) {
    const base = pseudoMatch[1].split(' ').map(escapeRe).join('\\s+')
    return new RegExp(`${base}\\s*:{1,2}${pseudoMatch[2]}\\s*\\{`)
  }
  const base = normalized.split(' ').map(escapeRe).join('\\s+')
  return new RegExp(`${base}\\s*\\{`)
}

/** Brace-count forward from `openBracePos` (the rule's `{`) to its matching `}`. */
function findRuleClose(content: string, openBracePos: number): number {
  let depth = 1
  for (let i = openBracePos + 1; i < content.length; i++) {
    if (content[i] === '{') depth++
    else if (content[i] === '}') { depth--; if (depth === 0) return i }
  }
  return -1
}

function computeCssBackgroundImage(content: string, params: WriteCssBackgroundImageParams): MutateOutcome {
  const selectorRe = buildSelectorRegex(params.selectorText)
  const selMatch = selectorRe.exec(content)
  if (!selMatch) {
    return {
      success: false,
      error: `Could not find the rule "${params.selectorText}" in ${params.filePath} — it may have been reformatted or moved. No changes were made.`,
    }
  }

  const openBracePos = selMatch.index + selMatch[0].length - 1
  const closeBracePos = findRuleClose(content, openBracePos)
  if (closeBracePos === -1) {
    return { success: false, error: `Could not find the closing brace for "${params.selectorText}" in ${params.filePath}.` }
  }

  const writtenLine = content.slice(0, openBracePos).split('\n').length
  const newValue = `url("${params.newUrl}")`

  const body = content.slice(openBracePos + 1, closeBracePos)
  const declMatch = /background-image\s*:\s*/.exec(body)

  let newContent: string
  if (declMatch) {
    const valueStart = openBracePos + 1 + declMatch.index + declMatch[0].length
    let valueEnd = content.indexOf(';', valueStart)
    if (valueEnd === -1 || valueEnd > closeBracePos) valueEnd = closeBracePos
    newContent = content.slice(0, valueStart) + newValue + content.slice(valueEnd)
  } else {
    // No existing declaration — insert one right after the opening brace.
    const insertion = `\n  background-image: ${newValue};`
    newContent = content.slice(0, openBracePos + 1) + insertion + content.slice(openBracePos + 1)
  }

  if (newContent === content) return { success: true, lineNumber: writtenLine } // no-op
  return { success: true, newContent, lineNumber: writtenLine }
}

export function writeCssBackgroundImage(params: WriteCssBackgroundImageParams): WriteCssBackgroundImageResult {
  const result = applySourceTransaction({
    projectPath: params.projectPath,
    filePath: params.filePath,
    description: params.description,
    editType: params.editType,
    element: params.element,
    mutate: (content) => computeCssBackgroundImage(content, params),
  })
  if (result.success && result.historyRecorded) {
    console.log(`[cssBackgroundWriter] wrote background-image for "${params.selectorText}" in ${params.filePath}:${result.lineNumber}`)
  }
  return result
}
