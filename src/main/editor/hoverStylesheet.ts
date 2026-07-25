/**
 * Hover-state persistence: a stable per-element style class + a small shared
 * project stylesheet.
 *
 * Inline `style={{}}` can express the NORMAL state but not `:hover` — CSS
 * needs a real selector for that. So the first time an element gets a hover
 * style, we (1) give it a stable, deterministic class (`hb-style-<id>`, hashed
 * from its source file+line so the same element always gets the same class
 * across saves/reopens — no separate id-mapping store needed), (2) write/merge
 * a `.hb-style-<id>:hover { ... }` rule into a shared stylesheet, and (3)
 * make sure the component file imports that stylesheet once.
 */
import * as fs from 'fs'
import * as path from 'path'
import { MutateOutcome } from './sourceTransaction'

const STYLESHEET_BASENAME = 'hb-styles.css'

/** camelCase → kebab-case (color, not colour, to match CSSStyleDeclaration keys). */
function toKebabCase(prop: string): string {
  return prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
}

/** Deterministic short id from a source location — same element, same id, every time. */
export function computeStyleId(filePath: string, sourceLine: number): string {
  const input = `${filePath}:${sourceLine}`
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
 * Read the stylesheet (missing file → empty string, never throws) and return
 * new content with the `.hb-style-<id>:hover { ... }` rule upserted. Passing
 * an empty `hoverProps` removes the rule (used when the user clears all hover
 * values). Returns a no-op MutateOutcome if nothing actually changes.
 */
export function computeHoverStylesheetMutation(
  content: string,
  styleId: string,
  hoverProps: Record<string, string>
): MutateOutcome {
  const selector = `.hb-style-${styleId}:hover`
  const blockPattern = new RegExp(`${selector.replace(/[.:]/g, '\\$&')}\\s*\\{[^}]*\\}\\n?`, 'm')

  const entries = Object.entries(hoverProps).filter(([, v]) => v !== '')

  if (entries.length === 0) {
    if (!blockPattern.test(content)) return { success: true } // nothing to remove — no-op
    return { success: true, newContent: content.replace(blockPattern, '').trimEnd() + '\n' }
  }

  const body = entries.map(([k, v]) => `  ${toKebabCase(k)}: ${v};`).join('\n')
  const rule = `${selector} {\n${body}\n}\n`

  if (blockPattern.test(content)) {
    return { success: true, newContent: content.replace(blockPattern, rule) }
  }

  const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : ''
  return { success: true, newContent: `${content}${separator}${rule}` }
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
