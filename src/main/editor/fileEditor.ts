import * as fs from 'fs'
import * as path from 'path'

const SOURCE_EXTENSIONS = ['.html', '.htm', '.jsx', '.tsx', '.vue', '.svelte', '.astro', '.js', '.ts']
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.vite', 'build', 'release'])

// ─── types ───────────────────────────────────────────────────────────────────

export interface AnalyzeParams {
  projectPath: string
  oldText: string
  newText: string
  // Optional element context — used to boost confidence of matches
  tagName?: string
  id?: string | null
  classList?: string[]
  parentText?: string
  /** Absolute path of a file the user previously linked — gets +25 confidence. */
  preferredFile?: string
}

export type MatchStrategy = 'exact' | 'normalized' | 'jsx-word-proximity'

export interface SourceMatch {
  filePath: string
  lineNumber: number
  lineText: string
  contextBefore: string
  contextAfter: string
  matchOffset: number
  matchStrategy: MatchStrategy
  actualMatchText: string
  /** 0–100. Higher = more confident this is the right location. */
  confidence: number
}

export interface AnalysisDebugInfo {
  strategy: MatchStrategy | 'none'
  filesScanned: number
  extensionsSearched: string[]
  normalizedSearchText: string
  projectPath: string
  sourceFile?: string
  originalLine?: number
  searchedFromLine?: number
  searchedToLine?: number
}

export interface TextEditAnalysis {
  oldText: string
  newText: string
  matchCount: number
  matches: SourceMatch[]
  debugInfo: AnalysisDebugInfo
  /** True when matches exist but all are low-confidence — caller should force MatchConfirmPanel. */
  needsConfirmation: boolean
}

export interface LocatedEditParams {
  filePath: string
  lineNumber: number
  oldText: string
  newText: string
}

export interface CommitParams {
  filePath: string
  oldText: string
  newText: string
  actualMatchText?: string
  matchOffset?: number
}

export interface CommitResult {
  success: boolean
  filePath?: string
  lineNumber?: number
  oldText?: string
  newText?: string
  bytesWritten?: number
  error?: string
}

// ─── text normalisation ───────────────────────────────────────────────────────

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&apos;': "'", '&#39;': "'", '&nbsp;': ' ',
  '&ndash;': '–', '&mdash;': '—', '&laquo;': '«', '&raquo;': '»',
}

function decodeEntities(text: string): string {
  return text.replace(/&[a-z]+;|&#[0-9]+;|&#x[0-9a-f]+;/gi, (ent) => {
    if (ENTITY_MAP[ent]) return ENTITY_MAP[ent]
    if (ent.startsWith('&#x')) return String.fromCharCode(parseInt(ent.slice(3, -1), 16))
    if (ent.startsWith('&#'))  return String.fromCharCode(parseInt(ent.slice(2, -1), 10))
    return ent
  })
}

function normalizeText(text: string): string {
  return decodeEntities(text).replace(/\s+/g, ' ').trim()
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Tier-2 regex: allows whitespace and JSX string delimiters between words.
 * Handles "Hello\n  World" and "Hello{' '}World".
 * Does NOT bridge across HTML tags (< > are excluded from the gap).
 */
function buildFlexibleRegex(normalizedText: string): RegExp | null {
  const words = normalizedText.split(' ').filter((w) => w.length > 0)
  if (words.length < 2) return null

  const GAP = "[\\s{}'\"]{0,100}"
  const pattern = words.map(escapeRegex).join(GAP)
  try { return new RegExp(pattern, 'g') } catch { return null }
}

/**
 * Tier-4 regex: allows ANY characters (including HTML/JSX tags) between the
 * most significant words. Handles text interleaved with inline elements:
 *   "Click on here to learn" matching "Click on <a href="#">here</a> to learn"
 *
 * Uses non-greedy {0,200}? to find the shortest possible span.
 * Only words with 4+ chars are used to minimise false positives.
 */
function buildJsxWordRegex(normalizedText: string): RegExp | null {
  const words = normalizedText.split(' ').filter((w) => w.length >= 4)
  if (words.length < 2) return null

  const GAP = '[\\s\\S]{0,200}?'
  const pattern = words.map(escapeRegex).join(GAP)
  try {
    // 'g' for multiple matches; 's' flag (dotAll) isn't needed since we use [\s\S]
    return new RegExp(pattern, 'g')
  } catch { return null }
}

// ─── confidence scoring ───────────────────────────────────────────────────────

const BASE_CONFIDENCE: Record<MatchStrategy, number> = {
  'exact':               90,
  'normalized':          70,
  'jsx-word-proximity':  35,
}

/**
 * Boost the base confidence using element context signals.
 * Capped at 100.
 */
function applyContextBoost(base: number, content: string, params: AnalyzeParams, filePath: string): number {
  let score = base

  // Previously-linked file: user manually chose this location — strong boost
  if (params.preferredFile && filePath === params.preferredFile) score += 25

  // Tag name present as a JSX opening element (e.g. <h1 or <Button)
  if (params.tagName && content.includes(`<${params.tagName}`)) score += 5

  // Class names
  if (params.classList) {
    for (const cls of params.classList) {
      if (cls.length > 2 && content.includes(cls)) score += 4
    }
  }

  // ID
  if (params.id && params.id.length > 1 && content.includes(params.id)) score += 12

  // Parent text words
  if (params.parentText) {
    const parentWords = params.parentText.split(/\s+/).filter((w) => w.length > 4)
    const hits = parentWords.filter((w) => content.includes(w)).length
    score += Math.min(hits * 3, 9)
  }

  return Math.min(score, 100)
}

// ─── per-file match extraction ────────────────────────────────────────────────

function matchesFromFile(
  content:    string,
  filePath:   string,
  strategy:   MatchStrategy,
  searchText: string,
  regex?:     RegExp
): Omit<SourceMatch, 'confidence'>[] {
  const results: Omit<SourceMatch, 'confidence'>[] = []
  const lines = content.split('\n')

  function push(idx: number, matchedText: string): void {
    const lineNum = content.slice(0, idx).split('\n').length
    results.push({
      filePath,
      lineNumber:     lineNum,
      lineText:       lines[lineNum - 1] ?? '',
      contextBefore:  lineNum > 1 ? (lines[lineNum - 2] ?? '') : '',
      contextAfter:   lineNum < lines.length ? (lines[lineNum] ?? '') : '',
      matchOffset:    idx,
      matchStrategy:  strategy,
      actualMatchText: matchedText,
    })
  }

  if (strategy === 'exact') {
    let from = 0
    while (from < content.length) {
      const idx = content.indexOf(searchText, from)
      if (idx === -1) break
      push(idx, searchText)
      from = idx + searchText.length
    }
  } else if ((strategy === 'normalized' || strategy === 'jsx-word-proximity') && regex) {
    regex.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = regex.exec(content)) !== null) {
      push(m.index, m[0])
      if (m[0].length === 0) regex.lastIndex++
    }
  }

  return results
}

// ─── public API ───────────────────────────────────────────────────────────────

export function analyzeTextEdit(params: AnalyzeParams): TextEditAnalysis {
  const trimmedOld    = params.oldText.trim()
  const trimmedNew    = params.newText.trim()
  const normalizedOld = normalizeText(trimmedOld)
  const flexRegex     = buildFlexibleRegex(normalizedOld)
  const jsxRegex      = buildJsxWordRegex(normalizedOld)

  const debugInfo: AnalysisDebugInfo = {
    strategy:             'none',
    filesScanned:         0,
    extensionsSearched:   [...SOURCE_EXTENSIONS],
    normalizedSearchText: normalizedOld,
    projectPath:          params.projectPath,
  }

  const EMPTY: TextEditAnalysis = {
    oldText: trimmedOld, newText: trimmedNew,
    matchCount: 0, matches: [], debugInfo, needsConfirmation: false,
  }

  if (!trimmedOld) return EMPTY

  const allMatches: SourceMatch[] = []

  function walk(dir: string): void {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue

      debugInfo.filesScanned++

      let content: string
      try { content = fs.readFileSync(full, 'utf-8') } catch { continue }

      let fileMatches: Omit<SourceMatch, 'confidence'>[] = []
      let baseConfidence = 0

      // ── tier 1: exact substring ────────────────────────────────────────────
      if (content.includes(trimmedOld)) {
        fileMatches    = matchesFromFile(content, full, 'exact', trimmedOld)
        baseConfidence = BASE_CONFIDENCE['exact']
      }
      // ── tier 2: whitespace-flexible regex ─────────────────────────────────
      else if (flexRegex) {
        fileMatches    = matchesFromFile(content, full, 'normalized', trimmedOld, flexRegex)
        baseConfidence = BASE_CONFIDENCE['normalized']
      }
      // ── tier 3: entity-decoded exact ──────────────────────────────────────
      else if (normalizedOld !== trimmedOld && content.includes(normalizedOld)) {
        fileMatches    = matchesFromFile(content, full, 'normalized', normalizedOld)
        baseConfidence = 60  // slightly below normal 'normalized'
      }
      // ── tier 4: JSX/HTML-tag-aware word proximity ─────────────────────────
      else if (jsxRegex) {
        fileMatches    = matchesFromFile(content, full, 'jsx-word-proximity', trimmedOld, jsxRegex)
        baseConfidence = BASE_CONFIDENCE['jsx-word-proximity']
      }

      if (fileMatches.length === 0) continue

      const boosted = applyContextBoost(baseConfidence, content, params, full)
      for (const m of fileMatches) {
        allMatches.push({ ...m, confidence: boosted })
      }
    }
  }

  walk(params.projectPath)

  // Sort by confidence descending so best matches come first
  allMatches.sort((a, b) => b.confidence - a.confidence)

  // Update debug strategy
  if (allMatches.length > 0) {
    const best = allMatches[0]
    debugInfo.strategy = best.matchStrategy === 'normalized' ? 'normalized' :
                         best.matchStrategy === 'exact'      ? 'exact'      :
                         'jsx-word-proximity' as MatchStrategy
  }

  // needsConfirmation = all matches are low confidence (tier 4 only)
  const highConf      = allMatches.filter((m) => m.confidence >= 60)
  const needsConfirmation = allMatches.length > 0 && highConf.length === 0

  console.log(
    `[fileEditor] analyzeTextEdit: ${debugInfo.filesScanned} files, ` +
    `${allMatches.length} match(es)` +
    (allMatches.length > 0 ? ` best-confidence=${allMatches[0].confidence}` : '') +
    (needsConfirmation ? ' [needs-confirmation]' : ''),
    allMatches.map((m) => `${path.relative(params.projectPath, m.filePath)}:${m.lineNumber} (${m.confidence})`)
  )

  return {
    oldText: trimmedOld, newText: trimmedNew,
    matchCount: allMatches.length, matches: allMatches,
    debugInfo, needsConfirmation,
  }
}

/**
 * Search a single file within ±20 lines of a known source location.
 * Uses the same 4-tier matching as analyzeTextEdit but restricted to a line
 * window, and adds +30 confidence for being in the confirmed source file.
 */
export function analyzeLocatedEdit(params: LocatedEditParams): TextEditAnalysis {
  const { filePath, lineNumber, oldText, newText } = params
  const trimmedOld    = oldText.trim()
  const trimmedNew    = newText.trim()
  const normalizedOld = normalizeText(trimmedOld)
  const flexRegex     = buildFlexibleRegex(normalizedOld)
  const jsxRegex      = buildJsxWordRegex(normalizedOld)
  const ext           = path.extname(filePath)

  const emptyDebug: AnalysisDebugInfo = {
    strategy: 'none', filesScanned: 1,
    extensionsSearched: [ext],
    normalizedSearchText: normalizedOld,
    projectPath: path.dirname(filePath),
  }
  const EMPTY: TextEditAnalysis = {
    oldText: trimmedOld, newText: trimmedNew,
    matchCount: 0, matches: [], debugInfo: emptyDebug, needsConfirmation: false,
  }

  if (!trimmedOld || !filePath) return EMPTY

  let content: string
  try { content = fs.readFileSync(filePath, 'utf-8') } catch { return EMPTY }

  const allLines = content.split('\n')
  let fromLine = 0
  let toLine = 0
  let windowStart = 0
  let windowEnd = 0

  function setWindow(radius: number): void {
    fromLine = Math.max(1, lineNumber - radius)
    toLine = Math.min(allLines.length, lineNumber + radius)
    windowStart = 0
    for (let i = 0; i < fromLine - 1; i++) windowStart += allLines[i].length + 1
    windowEnd = windowStart
    for (let i = fromLine - 1; i < toLine; i++) windowEnd += allLines[i].length + 1
  }

  // Run a matching tier against full content, then filter to window offsets.
  // Full-content pass is correct: matchesFromFile returns true byte offsets and
  // 1-based line numbers relative to the real file.
  function tryTier(
    strat: MatchStrategy,
    searchText: string,
    base: number,
    regex?: RegExp,
  ): Omit<SourceMatch, 'confidence'>[] {
    const raw = matchesFromFile(content, filePath, strat, searchText, regex)
    return raw.filter((m) => m.matchOffset >= windowStart && m.matchOffset < windowEnd)
  }

  let rawMatches: Omit<SourceMatch, 'confidence'>[] = []
  let base = 0
  let strat: MatchStrategy | 'none' = 'none'

  function searchWindow(radius: number): void {
    setWindow(radius)
    if (content.includes(trimmedOld)) {
      rawMatches = tryTier('exact', trimmedOld, BASE_CONFIDENCE['exact'])
      if (rawMatches.length) { base = BASE_CONFIDENCE['exact']; strat = 'exact'; return }
    }
    if (flexRegex) {
      rawMatches = tryTier('normalized', trimmedOld, BASE_CONFIDENCE['normalized'], flexRegex)
      if (rawMatches.length) { base = BASE_CONFIDENCE['normalized']; strat = 'normalized'; return }
    }
    if (normalizedOld !== trimmedOld && content.includes(normalizedOld)) {
      rawMatches = tryTier('normalized', normalizedOld, 60)
      if (rawMatches.length) { base = 60; strat = 'normalized'; return }
    }
    if (jsxRegex) {
      rawMatches = tryTier('jsx-word-proximity', trimmedOld, BASE_CONFIDENCE['jsx-word-proximity'], jsxRegex)
      if (rawMatches.length) { base = BASE_CONFIDENCE['jsx-word-proximity']; strat = 'jsx-word-proximity' }
    }
  }

  searchWindow(20)
  if (!rawMatches.length) searchWindow(120)

  // +30 confidence boost — we know this is the right file and approximate line
  const matches: SourceMatch[] = rawMatches.map((m) => ({
    ...m,
    confidence: Math.min(100, base + 30),
  }))

  console.log(
    `[locatedEdit] file=${filePath} targetLine=${lineNumber} window=${fromLine}–${toLine} ` +
    `oldText="${trimmedOld.slice(0, 40)}" → ${matches.length} match(es)` +
    (matches.length > 0 ? ` at line ${matches[0].lineNumber} (confidence ${matches[0].confidence})` : '')
  )

  return {
    oldText: trimmedOld, newText: trimmedNew,
    matchCount: matches.length, matches,
    debugInfo: {
      ...emptyDebug, strategy: strat, sourceFile: filePath, originalLine: lineNumber,
      searchedFromLine: fromLine, searchedToLine: toLine,
    },
    needsConfirmation: false,
  }
}

export function commitTextEdit(params: CommitParams): CommitResult {
  const { filePath, oldText, newText, actualMatchText, matchOffset } = params
  const textToReplace = actualMatchText ?? oldText

  console.log(
    `[fileEditor] commitTextEdit: "${textToReplace.slice(0, 40)}" → "${newText.slice(0, 40)}"`,
    `in ${filePath}${matchOffset !== undefined ? ` @${matchOffset}` : ''}`
  )

  try {
    const original = fs.readFileSync(filePath, 'utf-8')
    let updated: string
    let matchIdx: number

    if (matchOffset !== undefined) {
      const atOffset = original.slice(matchOffset, matchOffset + textToReplace.length)
      if (atOffset !== textToReplace) {
        return {
          success: false, filePath, oldText, newText,
          error: `File changed since analysis — expected "${textToReplace.slice(0, 30)}" at offset ${matchOffset}`
        }
      }
      updated  = original.slice(0, matchOffset) + newText + original.slice(matchOffset + textToReplace.length)
      matchIdx = matchOffset
    } else {
      matchIdx = original.indexOf(textToReplace)
      if (matchIdx === -1) {
        return {
          success: false, filePath, oldText, newText,
          error: 'Text not found in file — file may have changed since analysis'
        }
      }
      updated = original.replace(textToReplace, newText)
    }

    fs.writeFileSync(filePath, updated, 'utf-8')

    const lineNumber    = original.slice(0, matchIdx).split('\n').length
    const { size: bytesWritten } = fs.statSync(filePath)

    console.log(`[commit] ✓ wrote ${filePath} line ${lineNumber} (${bytesWritten} bytes)`)
    return { success: true, filePath, lineNumber, oldText, newText, bytesWritten }

  } catch (err) {
    const error = String(err)
    console.error('[commit] commitTextEdit failed:', error)
    return { success: false, filePath, oldText, newText, error }
  }
}
