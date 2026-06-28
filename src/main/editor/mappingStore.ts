/**
 * Mapping store — persists element → source-location bindings so that
 * future saves for the same element can go directly to the right file.
 *
 * Stored at <projectRoot>/.handybuilder/mappings.json.
 * Written only when the user manually confirms a source location.
 */
import * as fs from 'fs'
import * as path from 'path'

export interface ElementMapping {
  /** Stable key: tagName + #id + .class1.class2 */
  key: string
  tagName: string
  id: string | null
  classList: string[]
  /** Original text at the time the mapping was created */
  oldText: string
  filePath: string
  lineNumber?: number
  lastUsed: number
}

const MAPPING_DIR  = '.handybuilder'
const MAPPING_FILE = 'mappings.json'

function mappingPath(projectPath: string): string {
  return path.join(projectPath, MAPPING_DIR, MAPPING_FILE)
}

function loadAll(projectPath: string): Record<string, ElementMapping> {
  try {
    const raw = fs.readFileSync(mappingPath(projectPath), 'utf-8')
    return JSON.parse(raw) as Record<string, ElementMapping>
  } catch {
    return {}
  }
}

export function getMapping(projectPath: string, key: string): ElementMapping | null {
  return loadAll(projectPath)[key] ?? null
}

export function saveMapping(projectPath: string, mapping: ElementMapping): void {
  try {
    const dir = path.join(projectPath, MAPPING_DIR)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const all = loadAll(projectPath)
    all[mapping.key] = { ...mapping, lastUsed: Date.now() }
    fs.writeFileSync(mappingPath(projectPath), JSON.stringify(all, null, 2), 'utf-8')
    console.log(`[mappingStore] saved mapping ${mapping.key} → ${mapping.filePath}`)
  } catch (err) {
    console.error('[mappingStore] saveMapping failed:', err)
  }
}

/** Stable element key. Empty parts are omitted. */
export function buildElementKey(
  tagName: string,
  id: string | null,
  classList: string[]
): string {
  const idPart  = id ? `#${id}` : ''
  const clsPart = classList.filter((c) => c.length > 0).map((c) => `.${c}`).join('')
  return `${tagName}${idPart}${clsPart}`
}
