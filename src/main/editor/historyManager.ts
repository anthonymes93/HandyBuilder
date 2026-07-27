/**
 * Edit history — multi-level Undo/Redo backed by full file snapshots.
 *
 * Persisted per-project at <projectRoot>/.handybuilder/history.json, mirroring
 * the read/write pattern used by mappingStore.ts (missing/corrupt file → safe
 * empty default; writes are best-effort and never throw).
 *
 * Model: a single chronological `entries` array plus a `cursor` index.
 * entries[0..cursor) are the "undo stack" (applied edits, newest last).
 * entries[cursor..]  are the "redo stack" (undone edits, in original order).
 * Undo decrements cursor (writing beforeContent); redo increments it (writing
 * afterContent). Recording a new entry after an undo truncates everything
 * from cursor onward — the classic array-with-cursor undo model.
 *
 * Each entry holds a LIST of file changes, not just one — a single visual
 * style Save can touch both the component file (className/inline style) and
 * a shared hover stylesheet, and both must undo/redo together as one step.
 */
import * as fs from 'fs'
import * as path from 'path'

export type HistoryEditType = 'text' | 'image' | 'link' | 'style' | 'ast-binding' | 'manual-edit' | 'delete'

export interface HistoryElementMeta {
  tagName?: string
  id?: string | null
  classList?: string[]
}

export interface HistoryFileChange {
  filePath: string
  beforeContent: string
  afterContent: string
}

export interface HistoryEntry {
  id: string
  timestamp: number
  editType: HistoryEditType
  sourceLine?: number
  description: string
  element?: HistoryElementMeta
  /** One or more files changed atomically by this single edit. */
  changes: HistoryFileChange[]
}

/** What the renderer actually needs for the History panel — no content blobs. */
export interface HistoryEntrySummary {
  id: string
  timestamp: number
  editType: HistoryEditType
  /** Primary (first) file touched — used for display. */
  filePath: string
  fileCount: number
  sourceLine?: number
  description: string
  element?: HistoryElementMeta
}

export interface HistoryState {
  entries: HistoryEntrySummary[]
  cursor: number
  canUndo: boolean
  canRedo: boolean
  undoDescription?: string
  redoDescription?: string
}

export interface HistoryOpResult {
  success: boolean
  error?: string
  conflict?: boolean
  description?: string
  filePath?: string
  state: HistoryState
}

const HISTORY_DIR  = '.handybuilder'
const HISTORY_FILE = 'history.json'
const MAX_ENTRIES  = 100
const MAX_ENTRY_BYTES = 2 * 1024 * 1024 // 2 MB — cap per file snapshot (before or after)

interface StoredHistory {
  entries: HistoryEntry[]
  cursor: number
}

// In-memory cache, keyed by absolute project path — never mixes projects.
const cache = new Map<string, StoredHistory>()

function historyPath(projectPath: string): string {
  return path.join(projectPath, HISTORY_DIR, HISTORY_FILE)
}

function emptyHistory(): StoredHistory {
  return { entries: [], cursor: 0 }
}

function loadFromDisk(projectPath: string): StoredHistory {
  try {
    const raw = fs.readFileSync(historyPath(projectPath), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<StoredHistory>
    if (!Array.isArray(parsed.entries)) return emptyHistory()
    // Reject anything not shaped like the current (changes[]) schema — safer
    // than trying to migrate an old single-file entry shape.
    const valid = parsed.entries.every((e) => Array.isArray((e as HistoryEntry).changes))
    if (!valid) return emptyHistory()
    const cursor = typeof parsed.cursor === 'number'
      ? Math.max(0, Math.min(parsed.cursor, parsed.entries.length))
      : parsed.entries.length
    return { entries: parsed.entries, cursor }
  } catch {
    return emptyHistory() // missing or corrupt — safe default, never throws
  }
}

function getStore(projectPath: string): StoredHistory {
  let store = cache.get(projectPath)
  if (!store) {
    store = loadFromDisk(projectPath)
    cache.set(projectPath, store)
  }
  return store
}

function persist(projectPath: string, store: StoredHistory): void {
  try {
    const dir = path.join(projectPath, HISTORY_DIR)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(historyPath(projectPath), JSON.stringify(store, null, 2), 'utf-8')
  } catch (err) {
    console.error('[historyManager] persist failed:', err)
  }
}

function toSummary(e: HistoryEntry): HistoryEntrySummary {
  return {
    id: e.id,
    timestamp: e.timestamp,
    editType: e.editType,
    filePath: e.changes[0]?.filePath ?? '',
    fileCount: e.changes.length,
    sourceLine: e.sourceLine,
    description: e.description,
    element: e.element,
  }
}

function toState(store: StoredHistory): HistoryState {
  const undoEntry = store.cursor > 0 ? store.entries[store.cursor - 1] : undefined
  const redoEntry = store.cursor < store.entries.length ? store.entries[store.cursor] : undefined
  return {
    // newest first, for the History panel
    entries: [...store.entries].reverse().map(toSummary),
    cursor: store.cursor,
    canUndo: !!undoEntry,
    canRedo: !!redoEntry,
    undoDescription: undoEntry?.description,
    redoDescription: redoEntry?.description,
  }
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

// ─── public API ────────────────────────────────────────────────────────────

export function getHistoryState(projectPath: string): HistoryState {
  return toState(getStore(projectPath))
}

export interface RecordEntryParams {
  editType: HistoryEditType
  sourceLine?: number
  description: string
  element?: HistoryElementMeta
  changes: HistoryFileChange[]
}

export interface RecordEntryResult {
  recorded: boolean
  reason?: string
  state: HistoryState
}

/**
 * Push a new history entry covering one or more file changes, applied and
 * undone/redone together as a single atomic step. No-ops (before === after
 * for every file) are rejected by the caller before this is invoked (see
 * sourceTransaction.ts). Truncates any redo entries, enforces the 2 MB
 * per-file-snapshot cap and the 100-entry cap.
 */
export function recordHistoryEntry(projectPath: string, params: RecordEntryParams): RecordEntryResult {
  const store = getStore(projectPath)

  if (params.changes.length === 0) {
    return { recorded: false, reason: 'no-op', state: toState(store) }
  }

  for (const change of params.changes) {
    const beforeBytes = Buffer.byteLength(change.beforeContent, 'utf-8')
    const afterBytes  = Buffer.byteLength(change.afterContent, 'utf-8')
    if (beforeBytes > MAX_ENTRY_BYTES || afterBytes > MAX_ENTRY_BYTES) {
      return { recorded: false, reason: 'File exceeds the 2 MB undo-history size limit', state: toState(store) }
    }
  }

  // A new edit after undoing invalidates the redo stack.
  store.entries = store.entries.slice(0, store.cursor)

  const entry: HistoryEntry = {
    id: makeId(),
    timestamp: Date.now(),
    editType: params.editType,
    sourceLine: params.sourceLine,
    description: params.description,
    element: params.element,
    changes: params.changes,
  }

  store.entries.push(entry)
  store.cursor = store.entries.length

  if (store.entries.length > MAX_ENTRIES) {
    const overflow = store.entries.length - MAX_ENTRIES
    store.entries = store.entries.slice(overflow)
    store.cursor = store.entries.length
  }

  persist(projectPath, store)
  return { recorded: true, state: toState(store) }
}

/** Read a file, returning null (not throwing) if it can't be read. */
function safeRead(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

export function undoHistory(projectPath: string): HistoryOpResult {
  const store = getStore(projectPath)
  if (store.cursor <= 0) {
    return { success: false, error: 'Nothing to undo', state: toState(store) }
  }

  const entry = store.entries[store.cursor - 1]

  // Verify every file first — abort entirely (write nothing) if any mismatch.
  for (const change of entry.changes) {
    const current = safeRead(change.filePath)
    if (current === null) {
      return { success: false, error: `Cannot read ${change.filePath}`, state: toState(store) }
    }
    if (current !== change.afterContent) {
      return {
        success: false,
        conflict: true,
        filePath: change.filePath,
        error: 'File changed outside HandyBuilder. Undo was cancelled to prevent data loss.',
        state: toState(store),
      }
    }
  }

  for (const change of entry.changes) {
    try {
      fs.writeFileSync(change.filePath, change.beforeContent, 'utf-8')
    } catch (err) {
      return { success: false, error: `Cannot write ${change.filePath}: ${String(err)}`, state: toState(store) }
    }
    const verify = safeRead(change.filePath)
    if (verify !== change.beforeContent) {
      return { success: false, error: `Undo verification failed for ${change.filePath}`, state: toState(store) }
    }
  }

  store.cursor -= 1
  persist(projectPath, store)
  return { success: true, description: entry.description, filePath: entry.changes[0]?.filePath, state: toState(store) }
}

export function redoHistory(projectPath: string): HistoryOpResult {
  const store = getStore(projectPath)
  if (store.cursor >= store.entries.length) {
    return { success: false, error: 'Nothing to redo', state: toState(store) }
  }

  const entry = store.entries[store.cursor]

  for (const change of entry.changes) {
    const current = safeRead(change.filePath)
    if (current === null) {
      return { success: false, error: `Cannot read ${change.filePath}`, state: toState(store) }
    }
    if (current !== change.beforeContent) {
      return {
        success: false,
        conflict: true,
        filePath: change.filePath,
        error: 'File changed outside HandyBuilder. Redo was cancelled to prevent data loss.',
        state: toState(store),
      }
    }
  }

  for (const change of entry.changes) {
    try {
      fs.writeFileSync(change.filePath, change.afterContent, 'utf-8')
    } catch (err) {
      return { success: false, error: `Cannot write ${change.filePath}: ${String(err)}`, state: toState(store) }
    }
    const verify = safeRead(change.filePath)
    if (verify !== change.afterContent) {
      return { success: false, error: `Redo verification failed for ${change.filePath}`, state: toState(store) }
    }
  }

  store.cursor += 1
  persist(projectPath, store)
  return { success: true, description: entry.description, filePath: entry.changes[0]?.filePath, state: toState(store) }
}

export function clearHistory(projectPath: string): HistoryState {
  const store = emptyHistory()
  cache.set(projectPath, store)
  persist(projectPath, store)
  return toState(store)
}

/** Drop every entry that touches a specific file (e.g. after an external-change conflict). */
export function discardHistoryForFile(projectPath: string, filePath: string): HistoryState {
  const store = getStore(projectPath)
  let removedBeforeCursor = 0
  const kept: HistoryEntry[] = []
  store.entries.forEach((e, i) => {
    if (e.changes.some((c) => c.filePath === filePath)) {
      if (i < store.cursor) removedBeforeCursor++
      return
    }
    kept.push(e)
  })
  store.entries = kept
  store.cursor = Math.max(0, store.cursor - removedBeforeCursor)
  persist(projectPath, store)
  return toState(store)
}
