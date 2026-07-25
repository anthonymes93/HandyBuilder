/**
 * Central transaction helper — every source-writing editor (text, image,
 * link, style, AST binding, manual edit) funnels through this so undo/redo
 * history is recorded consistently in exactly one place.
 */
import * as fs from 'fs'
import { HistoryEditType, HistoryElementMeta, HistoryFileChange, recordHistoryEntry } from './historyManager'

export interface MutateOutcome {
  success: boolean
  /** Full new file content. Omit (or equal to the before-content) for a no-op. */
  newContent?: string
  error?: string
  /** Override the reported line number (e.g. the line a writer actually located). */
  lineNumber?: number
}

export interface FileMutation {
  filePath: string
  mutate: (beforeContent: string) => MutateOutcome
  /** This file is optional — if its mutate() reports a no-op, skip it silently rather than failing the whole transaction. */
  optional?: boolean
}

export interface SourceTransactionParams {
  projectPath: string
  filePath: string
  description: string
  editType: HistoryEditType
  sourceLine?: number
  element?: HistoryElementMeta
  mutate: (beforeContent: string) => MutateOutcome
}

export interface MultiFileTransactionParams {
  projectPath: string
  description: string
  editType: HistoryEditType
  sourceLine?: number
  element?: HistoryElementMeta
  files: FileMutation[]
}

export interface SourceTransactionResult {
  success: boolean
  filePath?: string
  lineNumber?: number
  error?: string
  /** False for no-ops or when the file exceeded the history size cap. */
  historyRecorded?: boolean
  skippedReason?: string
  /** Files actually written (non-no-op) as part of this transaction. */
  filesChanged?: string[]
}

/**
 * Apply one or more file mutations as a single atomic, undoable edit: read
 * every before-content, run every mutate(), write every changed file, verify
 * every write, then record ONE history entry covering all of them. If any
 * required (non-optional) file mutation fails, nothing is written.
 */
export function applySourceTransactionMulti(params: MultiFileTransactionParams): SourceTransactionResult {
  const { projectPath, description, editType, sourceLine, element, files } = params

  if (files.length === 0) {
    return { success: false, error: 'No files to write' }
  }

  const beforeContents = new Map<string, string>()
  for (const f of files) {
    try {
      beforeContents.set(f.filePath, fs.readFileSync(f.filePath, 'utf-8'))
    } catch (err) {
      return { success: false, error: `Cannot read ${f.filePath}: ${String(err)}` }
    }
  }

  let lineNumber = sourceLine
  const toWrite: Array<{ filePath: string; before: string; after: string }> = []

  for (const f of files) {
    const before = beforeContents.get(f.filePath)!
    let outcome: MutateOutcome
    try {
      outcome = f.mutate(before)
    } catch (err) {
      if (f.optional) continue
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }

    if (!outcome.success) {
      if (f.optional) continue
      return { success: false, error: outcome.error ?? 'Edit failed' }
    }

    if (outcome.lineNumber !== undefined) lineNumber = outcome.lineNumber

    if (outcome.newContent === undefined || outcome.newContent === before) {
      continue // no-op for this file — nothing to write
    }

    toWrite.push({ filePath: f.filePath, before, after: outcome.newContent })
  }

  if (toWrite.length === 0) {
    return { success: true, filePath: files[0].filePath, lineNumber, historyRecorded: false, skippedReason: 'no-op' }
  }

  const written: string[] = []
  for (const w of toWrite) {
    try {
      fs.writeFileSync(w.filePath, w.after, 'utf-8')
      written.push(w.filePath)
    } catch (err) {
      return { success: false, error: `Cannot write ${w.filePath}: ${String(err)}`, filesChanged: written }
    }
  }

  const changes: HistoryFileChange[] = []
  for (const w of toWrite) {
    let afterContent: string
    try {
      afterContent = fs.readFileSync(w.filePath, 'utf-8')
    } catch (err) {
      return { success: false, error: `Wrote file but could not verify ${w.filePath}: ${String(err)}`, filesChanged: written }
    }
    if (afterContent !== w.after) {
      return { success: false, error: `Write verification failed for ${w.filePath}`, filesChanged: written }
    }
    changes.push({ filePath: w.filePath, beforeContent: w.before, afterContent })
  }

  const recorded = recordHistoryEntry(projectPath, {
    editType,
    sourceLine: lineNumber,
    description,
    element,
    changes,
  })

  return {
    success: true,
    filePath: files[0].filePath,
    lineNumber,
    historyRecorded: recorded.recorded,
    skippedReason: recorded.reason,
    filesChanged: written,
  }
}

/** Convenience wrapper for the common single-file case. */
export function applySourceTransaction(params: SourceTransactionParams): SourceTransactionResult {
  return applySourceTransactionMulti({
    projectPath: params.projectPath,
    description: params.description,
    editType: params.editType,
    sourceLine: params.sourceLine,
    element: params.element,
    files: [{ filePath: params.filePath, mutate: params.mutate }],
  })
}

export type { HistoryEditType, HistoryElementMeta }
