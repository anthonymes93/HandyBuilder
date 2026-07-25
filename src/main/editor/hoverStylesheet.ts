/**
 * Hover-state persistence: a stable per-element style class + a small shared
 * project stylesheet.
 *
 * Inline `style={{}}` can express the NORMAL state but not `:hover` — CSS
 * needs a real selector for that. So the first time an element gets a hover
 * style, we (1) give it a stable, deterministic class hashed from its full
 * identity (2) write/merge a `.<class>:hover { ... }` rule into a shared
 * stylesheet, and (3) make sure the component file imports that stylesheet
 * once.
 */
import * as fs from 'fs'
import * as path from 'path'
import { MutateOutcome } from './sourceTransaction'

const STYLESHEET_BASENAME = 'hb-styles.css'

/** camelCase → kebab-case (color, not colour, to match CSSStyleDeclaration keys). */
function toKebabCase(prop: string): string {
  return prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
}

/**
 * Everything that makes one JSX invocation unique. file+line alone collapses
 * to the SAME value for every item rendered from a `.map()` template — the
 * whole reason "this button only" used to affect every item — so itemId
 * (and pathname/text/href as extra disambiguators) must be folded in too.
 */
export interface StyleIdentity {
  file: string
  line: number
  column?: number | null
  pathname?: string | null
  itemId?: string | null
  text?: string | null
  href?: string | null
}

/** Deterministic short id from a full identity — same element, same id, every time. */
export function computeStyleId(identity: StyleIdentity): string {
  const input = [
    identity.file,
    identity.line,
    identity.column ?? '',
    identity.pathname ?? '',
    identity.itemId ?? '',
    identity.text ?? '',
    identity.href ?? '',
  ].join('|')
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0
  }
  return hash.toString(36).slice(0, 8)
}

/** Where the shared hover stylesheet lives for this project. */
export function hoverStylesheetPath(projectPath: string): string {
  const srcDir = path.join(projectPath, 'src')
  const base = fs.existsSync(srcDir) ? srcDir : projectPath
  return path.join(base, STYLESHEET_BASENAME)
}

/** Import specifier a component file should use to pull in the stylesheet. */
export function stylesheetImportSpecifier(componentFilePath: string, stylesheetAbsolutePath: string): string {
  let rel = path.relative(path.dirname(componentFilePath), stylesheetAbsolutePath)
  if (!rel.startsWith('.')) rel = `./${rel}`
  return rel.split(path.sep).join('/')
}

/**
 * Upsert ONE CSS rule for an exact single-class selector (never anything
 * broader like `a:hover` or `.button:hover`). Passing empty `props` removes
 * the rule if present. Returns whether anything actually changed.
 */
function upsertRule(content: string, selector: string, props: Record<string, string>): { content: string; changed: boolean } {
  const blockPattern = new RegExp(`${selector.replace(/[.:]/g, '\\$&')}\\s*\\{[^}]*\\}\\n?`, 'm')
  const entries = Object.entries(props).filter(([, v]) => v !== '')

  if (entries.length === 0) {
    if (!blockPattern.test(content)) return { content, changed: false }
    return { content: content.replace(blockPattern, '').trimEnd() + '\n', changed: true }
  }

  const body = entries.map(([k, v]) => `  ${toKebabCase(k)}: ${v};`).join('\n')
  const rule = `${selector} {\n${body}\n}\n`

  if (blockPattern.test(content)) {
    return { content: content.replace(blockPattern, rule), changed: true }
  }
  const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : ''
  return { content: `${content}${separator}${rule}`, changed: true }
}

/**
 * Read the stylesheet (missing file → empty string, never throws) and return
 * new content with `.<className> { ... }` (base) and/or `.<className>:hover
 * { ... }` rules upserted. Either props map may be empty (nothing written/
 * removed for that selector). Returns a no-op MutateOutcome if nothing
 * actually changes.
 *
 * `className` must be the FULL class (e.g. "hb-instance-a31f2" for a
 * per-instance edit, "hb-style-a31f2" for a shared/direct edit) — this
 * function only ever writes single-class selectors, never anything broader.
 */
export function computeScopedStylesheetMutation(
  content: string,
  className: string,
  baseProps: Record<string, string>,
  hoverProps: Record<string, string>
): MutateOutcome {
  let current = content
  let changed = false

  const base = upsertRule(current, `.${className}`, baseProps)
  current = base.content
  changed = changed || base.changed

  const hover = upsertRule(current, `.${className}:hover`, hoverProps)
  current = hover.content
  changed = changed || hover.changed

  if (!changed) return { success: true }
  return { success: true, newContent: current }
}

/** Convenience wrapper for the common hover-only case. */
export function computeHoverStylesheetMutation(
  content: string,
  className: string,
  hoverProps: Record<string, string>
): MutateOutcome {
  return computeScopedStylesheetMutation(content, className, {}, hoverProps)
}

/**
 * Ensure the component file imports the hover stylesheet exactly once.
 * No-op if already imported. Inserts after the last top-level import
 * statement, or at the top of the file if there are none.
 */
export function computeStylesheetImportMutation(content: string, importSpecifier: string): MutateOutcome {
  const already = new RegExp(`^import\\s+['"]${importSpecifier.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}['"]\\s*;?\\s*$`, 'm')
  if (already.test(content)) return { success: true } // no-op — already imported

  const importLine = `import '${importSpecifier}'\n`
  const importStatements = [...content.matchAll(/^import\s.+$/gm)]

  if (importStatements.length === 0) {
    return { success: true, newContent: importLine + content }
  }

  const last = importStatements[importStatements.length - 1]
  const insertAt = last.index! + last[0].length
  return {
    success: true,
    newContent: content.slice(0, insertAt) + '\n' + importLine.trimEnd() + content.slice(insertAt),
  }
}
