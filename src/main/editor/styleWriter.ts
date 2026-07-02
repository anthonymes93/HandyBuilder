import * as fs from 'fs'

// ─── public types ─────────────────────────────────────────────────────────────

export interface WriteInlineStyleParams {
  filePath: string
  lineNumber: number        // 1-based, from hbSourceLine / _debugSource.lineNumber
  styleProps: Record<string, string>  // camelCase prop → raw CSS value (no surrounding quotes)
  tagName?: string          // e.g. 'div', 'img' — used to narrow the tag search
}

export interface WriteInlineStyleResult {
  success: boolean
  filePath?: string
  lineNumber?: number
  error?: string
}

// ─── utilities ────────────────────────────────────────────────────────────────

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Scan through `content` starting at `pos`, tracking string and brace nesting,
 * until the JSX tag's closing `>` or `/>` is consumed.
 * Returns the index immediately after `>` / `/>`, or -1.
 */
function findTagClose(content: string, pos: number): number {
  let inSQ = false, inDQ = false, inTL = false, depth = 0

  for (; pos < content.length; pos++) {
    const ch = content[pos]

    if (inSQ) {
      if (ch === "'" && content[pos - 1] !== '\\') inSQ = false
      continue
    }
    if (inDQ) {
      if (ch === '"' && content[pos - 1] !== '\\') inDQ = false
      continue
    }
    if (inTL) {
      // Simplified: doesn't handle ${...} inside template literals, but adequate for JSX attrs.
      if (ch === '`') inTL = false
      continue
    }
    if (depth > 0) {
      if (ch === '{') depth++
      else if (ch === '}') depth--
      continue
    }

    // Unquoted, depth 0
    if      (ch === "'") inSQ = true
    else if (ch === '"') inDQ = true
    else if (ch === '`') inTL = true
    else if (ch === '{') depth++
    else if (ch === '/' && content[pos + 1] === '>') return pos + 2
    else if (ch === '>') return pos + 1
  }
  return -1
}

/**
 * Find the start/end character span of the JSX opening tag closest to
 * `targetLine` (1-based) within a ±`radius` line search window.
 * Returns null if no tag can be located.
 */
function findOpeningTagSpan(
  content: string,
  targetLine: number,
  tagHint?: string,
  radius = 8,
): { start: number; end: number } | null {
  const lines = content.split('\n')

  // Precompute 1-based line → character offset of line start
  const lineStart: number[] = [0, 0]  // lineStart[i] = offset of line i (1-based)
  for (let i = 1; i < lines.length; i++) {
    lineStart.push(lineStart[i] + lines[i - 1].length + 1)
  }

  const lo = Math.max(1, targetLine - radius)
  const hi = Math.min(lines.length, targetLine + radius)

  const windowStart = lineStart[lo]
  const windowEnd   = lineStart[hi] + lines[hi - 1].length
  const window      = content.slice(windowStart, windowEnd)

  // Match '<tagName' followed by whitespace, '/', or '>'
  const pattern = tagHint
    ? new RegExp(`<${escapeRe(tagHint)}(?=[\\s/>])`, 'gi')
    : /<[a-z][a-zA-Z0-9.-]*(?=[\s/>])/g

  let bestStart = -1
  let bestDist  = Infinity
  let bestEnd   = -1

  pattern.lastIndex = 0
  let m: RegExpExecArray | null

  while ((m = pattern.exec(window)) !== null) {
    const absStart = windowStart + m.index

    // Determine which line this match is on
    let lo2 = 1, hi2 = lines.length
    while (lo2 < hi2) {
      const mid = (lo2 + hi2 + 1) >> 1
      if (lineStart[mid] <= absStart) lo2 = mid
      else hi2 = mid - 1
    }
    const matchLine = lo2
    const dist = Math.abs(matchLine - targetLine)

    if (dist < bestDist) {
      const end = findTagClose(content, absStart + m[0].length)
      if (end !== -1) {
        bestDist  = dist
        bestStart = absStart
        bestEnd   = end
      }
    }
  }

  return bestStart === -1 ? null : { start: bestStart, end: bestEnd }
}

/**
 * Within a JSX opening tag's content (from `<tag` to its closing `>`), find
 * the span of the `style={{...}}` attribute.
 *
 * Returns the prop span and the inner object body span, or null if:
 * - no `style=` found
 * - the value is a variable reference like `style={hero}` (not an object literal)
 */
function findStylePropSpan(tagContent: string): {
  propStart: number
  propEnd: number
  bodyStart: number  // first char inside the {{ }}
  bodyEnd: number    // exclusive — first char of the closing }}
} | null {
  const m = /\bstyle\s*=\s*\{/g.exec(tagContent)
  if (!m) return null

  const propStart = m.index
  let pos = m.index + m[0].length  // position right after 'style={'

  // Require an object literal: next char must be '{'
  if (pos >= tagContent.length || tagContent[pos] !== '{') return null

  const bodyStart = pos + 1  // content starts after '{{'
  pos++                       // consume second '{'

  let depth = 2
  let inSQ = false, inDQ = false, inTL = false

  while (pos < tagContent.length && depth > 0) {
    const ch = tagContent[pos]
    if (inSQ) { if (ch === "'" && tagContent[pos - 1] !== '\\') inSQ = false }
    else if (inDQ) { if (ch === '"' && tagContent[pos - 1] !== '\\') inDQ = false }
    else if (inTL) { if (ch === '`') inTL = false }
    else {
      if      (ch === "'") inSQ = true
      else if (ch === '"') inDQ = true
      else if (ch === '`') inTL = true
      else if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    pos++
  }

  if (depth !== 0) return null  // unbalanced braces

  // pos is now the index AFTER the last '}'
  // The two '}}' were at pos-2 and pos-1
  return { propStart, propEnd: pos, bodyStart, bodyEnd: pos - 2 }
}

/**
 * Parse the body of a JSX style object literal (the content between `{{` and `}}`)
 * into a Map of camelCase key → raw value string (without surrounding quotes).
 *
 * Handles single-quoted, double-quoted, and backtick string values, plus
 * unquoted values (numbers, identifiers, function calls like `scale(1.5)`).
 */
function parseStyleBody(body: string): Map<string, string> {
  const result = new Map<string, string>()
  let i = 0

  while (i < body.length) {
    // Skip whitespace, commas, semicolons
    while (i < body.length && /[\s,;]/.test(body[i])) i++
    if (i >= body.length) break

    // Read key (camelCase identifier)
    if (!/[a-zA-Z_$]/.test(body[i])) { i++; continue }
    const keyStart = i
    while (i < body.length && /[a-zA-Z0-9_$]/.test(body[i])) i++
    const key = body.slice(keyStart, i)

    // Skip whitespace before ':'
    while (i < body.length && (body[i] === ' ' || body[i] === '\t' || body[i] === '\n' || body[i] === '\r')) i++
    if (body[i] !== ':') continue
    i++  // consume ':'

    // Skip whitespace after ':'
    while (i < body.length && (body[i] === ' ' || body[i] === '\t' || body[i] === '\n' || body[i] === '\r')) i++

    // Read value
    let value = ''
    const qch = body[i]

    if (qch === "'" || qch === '"' || qch === '`') {
      i++  // consume opening quote
      const start = i
      while (i < body.length && body[i] !== qch) {
        if (body[i] === '\\') i++  // skip escaped char
        i++
      }
      value = body.slice(start, i)
      if (i < body.length) i++  // consume closing quote
    } else {
      // Unquoted: read until comma or end, respecting nested brackets
      const start = i
      let depth = 0
      while (i < body.length) {
        const c = body[i]
        if ('({['.includes(c)) depth++
        else if (')}]'.includes(c)) { if (depth === 0) break; depth-- }
        else if (c === ',' && depth === 0) break
        i++
      }
      value = body.slice(start, i).trim()
    }

    if (key) result.set(key, value)
  }

  return result
}

/**
 * Quote a raw CSS value for use in a JSX style object.
 * Uses single quotes when the value contains double quotes; otherwise double quotes.
 */
function quoteValue(v: string): string {
  if (v.includes('"')) return `'${v}'`
  return `"${v}"`
}

/**
 * Serialise a style props Map to a single-line JSX `style` attribute string.
 * e.g. `style={{ backgroundSize: "150%", backgroundPosition: "50% 0%" }}`
 */
function buildStyleAttr(props: Map<string, string>): string {
  const entries = [...props.entries()]
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}: ${quoteValue(v)}`)
    .join(', ')
  return `style={{ ${entries} }}`
}

/**
 * Find the character position within `tagContent` just before the closing
 * `>` or `/>`, i.e. the correct place to insert a new attribute.
 * Returns -1 if not found.
 */
function findInsertionPoint(tagContent: string): number {
  const last = tagContent.length - 1
  if (last < 0 || tagContent[last] !== '>') return -1
  // Self-closing: ends with '/>'
  if (last >= 1 && tagContent[last - 1] === '/') return last - 1
  return last
}

// ─── array item prop writer ───────────────────────────────────────────────────

export interface WriteArrayItemPropParams {
  filePath:  string
  /** The unique string value used to identify the array item (e.g., project name). */
  itemId:    string
  /** The JS property key to add or update on the array item (e.g., 'image'). */
  propName:  string
  /** The raw value to write (no surrounding quotes). Empty string = delete the prop. */
  propValue: string
}

/**
 * Find an array item in a JS/TS source file by its unique string identifier,
 * then add or update a single property on that object literal.
 *
 * Works by:
 *   1. Locating `itemId` as a quoted string literal in the file.
 *   2. Brace-counting backward/forward to find the enclosing object `{ }`.
 *   3. Within that object, finding or inserting `propName: 'propValue'`.
 *
 * Note: brace counting does not skip string contents — values with `{`/`}` will
 * confuse the scanner. Portfolio-style flat object literals are safe.
 */
export function writeArrayItemProp(params: WriteArrayItemPropParams): WriteInlineStyleResult {
  const { filePath, itemId, propName, propValue } = params

  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch (err) {
    return { success: false, error: `Cannot read ${filePath}: ${String(err)}` }
  }

  // 1. Find itemId as a quoted string literal.
  const idPattern = new RegExp(`(['"])${escapeRe(itemId)}\\1`)
  const idMatch = idPattern.exec(content)
  if (!idMatch) {
    return { success: false, error: `Item "${itemId}" not found in ${filePath}` }
  }
  const idPos = idMatch.index

  // 2a. Scan BACKWARD from idPos to find the object's opening '{'.
  let objOpenPos = -1
  let depth = 0
  for (let i = idPos - 1; i >= 0; i--) {
    const ch = content[i]
    if (ch === '}') depth++
    else if (ch === '{') {
      if (depth === 0) { objOpenPos = i; break }
      depth--
    }
  }
  if (objOpenPos === -1) {
    return { success: false, error: `Cannot find object start for item "${itemId}" in ${filePath}` }
  }

  // 2b. Scan FORWARD from objOpenPos to find the matching closing '}'.
  depth = 1
  let objClosePos = -1
  for (let i = objOpenPos + 1; i < content.length; i++) {
    const ch = content[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) { objClosePos = i; break }
    }
  }
  if (objClosePos === -1) {
    return { success: false, error: `Cannot find object end for item "${itemId}" in ${filePath}` }
  }

  const objContent = content.slice(objOpenPos, objClosePos + 1)

  // 3. Find propName: within the object.
  const propPattern = new RegExp(`\\b${escapeRe(propName)}\\s*:`)
  const propMatch = propPattern.exec(objContent)

  let newContent: string

  if (propMatch) {
    // Prop exists — replace its value.
    const colonEnd = objOpenPos + propMatch.index + propMatch[0].length
    // Skip whitespace after ':'
    let valStart = colonEnd
    while (valStart < content.length && (content[valStart] === ' ' || content[valStart] === '\t')) valStart++

    // Read old value span
    let valEnd: number
    const qch = content[valStart]
    if (qch === "'" || qch === '"' || qch === '`') {
      valEnd = valStart + 1
      while (valEnd < content.length && content[valEnd] !== qch) {
        if (content[valEnd] === '\\') valEnd++
        valEnd++
      }
      valEnd++ // include closing quote
    } else {
      valEnd = valStart
      while (valEnd < content.length && content[valEnd] !== ',' && content[valEnd] !== '\n' && content[valEnd] !== '}') {
        valEnd++
      }
      while (valEnd > valStart && /\s/.test(content[valEnd - 1])) valEnd--
    }

    if (propValue === '') {
      // Delete the entire `propName: value,` line
      let lineStart = objOpenPos + propMatch.index
      while (lineStart > 0 && content[lineStart - 1] !== '\n') lineStart--
      let lineEnd = valEnd
      while (lineEnd < content.length && content[lineEnd] !== '\n') lineEnd++
      if (lineEnd < content.length) lineEnd++ // include the newline
      newContent = content.slice(0, lineStart) + content.slice(lineEnd)
    } else {
      newContent = content.slice(0, valStart) + `'${propValue}'` + content.slice(valEnd)
    }

  } else {
    // Prop not found — insert before the closing '}'.
    if (propValue === '') {
      return { success: true, filePath, lineNumber: content.slice(0, objOpenPos).split('\n').length }
    }
    // Derive indentation from the itemId line
    let lineStart = idPos
    while (lineStart > 0 && content[lineStart - 1] !== '\n') lineStart--
    const indent = content.slice(lineStart, idPos).match(/^(\s*)/)?.[1] ?? '    '
    const insertion = `${indent}${propName}: '${propValue}',\n`
    // Insert before the start of the closing-brace line (not mid-line after its indent)
    let closingLineStart = objClosePos
    while (closingLineStart > 0 && content[closingLineStart - 1] !== '\n') closingLineStart--
    newContent = content.slice(0, closingLineStart) + insertion + content.slice(closingLineStart)
  }

  try {
    fs.writeFileSync(filePath, newContent, 'utf-8')
  } catch (err) {
    return { success: false, error: `Cannot write ${filePath}: ${String(err)}` }
  }

  const writtenLine = content.slice(0, objOpenPos).split('\n').length
  console.log(`[styleWriter] wrote array item prop "${propName}" for "${itemId}" in ${filePath}:${writtenLine}`)
  return { success: true, filePath, lineNumber: writtenLine }
}

// ─── main export ─────────────────────────────────────────────────────────────

export function writeInlineStyle(params: WriteInlineStyleParams): WriteInlineStyleResult {
  const { filePath, lineNumber, styleProps, tagName } = params

  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch (err) {
    return { success: false, error: `Cannot read ${filePath}: ${String(err)}` }
  }

  const tagSpan = findOpeningTagSpan(content, lineNumber, tagName)
  if (!tagSpan) {
    return {
      success: false,
      error: `Could not locate JSX element near line ${lineNumber} in ${filePath}`,
    }
  }

  const tagContent = content.slice(tagSpan.start, tagSpan.end)
  const styleSpan  = findStylePropSpan(tagContent)

  let newTagContent: string

  if (styleSpan) {
    // Merge into the existing style={{ ... }} prop
    const body     = tagContent.slice(styleSpan.bodyStart, styleSpan.bodyEnd)
    const existing = parseStyleBody(body)

    for (const [k, v] of Object.entries(styleProps)) {
      if (v === '') {
        existing.delete(k)  // empty string = signal to remove this key
      } else {
        existing.set(k, v)
      }
    }

    const newAttr = buildStyleAttr(existing)
    newTagContent =
      tagContent.slice(0, styleSpan.propStart) +
      newAttr +
      tagContent.slice(styleSpan.propEnd)

  } else {
    // No existing style prop — insert one before the closing > or />
    const props = new Map<string, string>()
    for (const [k, v] of Object.entries(styleProps)) {
      if (v !== '') props.set(k, v)
    }
    if (props.size === 0) {
      return { success: true, filePath, lineNumber }
    }

    const insertAt = findInsertionPoint(tagContent)
    if (insertAt === -1) {
      return { success: false, error: 'Could not find closing bracket to insert style prop' }
    }

    const newAttr = buildStyleAttr(props)
    newTagContent =
      tagContent.slice(0, insertAt) + ' ' + newAttr + tagContent.slice(insertAt)
  }

  const newContent =
    content.slice(0, tagSpan.start) + newTagContent + content.slice(tagSpan.end)

  try {
    fs.writeFileSync(filePath, newContent, 'utf-8')
  } catch (err) {
    return { success: false, error: `Cannot write ${filePath}: ${String(err)}` }
  }

  const writtenLine = content.slice(0, tagSpan.start).split('\n').length
  console.log(`[styleWriter] wrote inline style to ${filePath}:${writtenLine}`)
  return { success: true, filePath, lineNumber: writtenLine }
}
