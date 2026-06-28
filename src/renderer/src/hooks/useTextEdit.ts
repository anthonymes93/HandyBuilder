import { useState, useCallback, useEffect, useRef } from 'react'
import {
  Project, TextEditPayload, TextEditAnalysis, SourceMatch,
  SaveStatus, SaveResult, CommitResult
} from '../types'

/** Build a stable element key for mapping lookup. */
export function buildElementKey(
  tagName: string,
  id: string | null | undefined,
  classList: string[] | undefined
): string {
  const idPart  = id ? `#${id}` : ''
  const clsPart = (classList ?? []).filter((c) => c.length > 0).map((c) => `.${c}`).join('')
  return `${tagName}${idPart}${clsPart}`
}

export interface UseTextEditReturn {
  saveStatus: SaveStatus
  saveResult: SaveResult
  pendingAnalysis: TextEditAnalysis | null
  handleTextSaved: (payload: TextEditPayload) => Promise<SaveStatus>
  handleConfirmMatch: (match: SourceMatch) => Promise<void>
  handleCancelConfirmation: () => void
  handleManualCommit: (match: SourceMatch, newText: string) => Promise<CommitResult>
  retryLastSave: () => Promise<void>
  dismissSaveResult: () => void
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function toRelative(abs: string | undefined, projectPath: string | undefined): string | undefined {
  if (!abs || !projectPath) return abs
  const prefix = projectPath.endsWith('/') ? projectPath : projectPath + '/'
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs
}

/**
 * Race a promise against a hard timeout.
 * Rejects with a descriptive Error if the timeout fires first.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
        ms
      )
    ),
  ])
}

const SAVE_TIMEOUT_MS = 8_000
const IDLE: SaveResult = { status: 'idle' }

// ─── hook ─────────────────────────────────────────────────────────────────────

export function useTextEdit(project: Project | null): UseTextEditReturn {
  const [saveResult, setSaveResult]          = useState<SaveResult>(IDLE)
  const [pendingAnalysis, setPendingAnalysis] = useState<TextEditAnalysis | null>(null)

  const saveStatus: SaveStatus = saveResult.status

  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function scheduleClear(ms: number): void {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
    clearTimerRef.current = setTimeout(() => setSaveResult(IDLE), ms)
  }

  useEffect(() => () => {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
  }, [])

  // ── main save entry point ──────────────────────────────────────────────────

  const handleTextSaved = useCallback(
    async (payload: TextEditPayload): Promise<SaveStatus> => {
      if (!project) {
        console.log('[useTextEdit] handleTextSaved: no project — skipping')
        return 'idle'
      }
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current)

      setSaveResult({ status: 'saving' })
      setPendingAnalysis(null)

      try {
        // ── fast path: source metadata available (Vite plugin or React fiber) ──
        if (payload.sourceFile && payload.sourceLine) {
          console.log(
            '[useTextEdit] using located edit: true →',
            payload.sourceFile, 'line', payload.sourceLine
          )

          const located = await withTimeout(
            window.api.analyzeLocatedEdit({
              filePath:   payload.sourceFile,
              lineNumber: payload.sourceLine,
              oldText:    payload.oldText,
              newText:    payload.newText,
            }),
            SAVE_TIMEOUT_MS,
            'analyzeLocatedEdit'
          )

          console.log(`[useTextEdit] analyzeLocatedEdit: ${located.matchCount} match(es)`)

          if (located.matchCount >= 1) {
            // Use the first (highest-confidence) match for auto-commit.
            // analyzeLocatedEdit never returns more than the matches within the
            // window, so even multiple hits are likely in the same block — just
            // take the first one.
            const match = located.matches[0]
            console.log('[useTextEdit] located → committing', match.filePath, 'line', match.lineNumber)

            const result = await withTimeout(
              window.api.commitTextEdit({
                filePath:        match.filePath,
                oldText:         located.oldText,
                newText:         located.newText,
                actualMatchText: match.actualMatchText,
                matchOffset:     match.matchOffset,
              }),
              SAVE_TIMEOUT_MS,
              'commitTextEdit (located)'
            )

            if (result.success && result.filePath) {
              setSaveResult({
                status:       'saved',
                filePath:     result.filePath,
                relativePath: toRelative(result.filePath, project.path),
                lineNumber:   result.lineNumber,
              })
              scheduleClear(10_000)
              return 'saved'
            }

            console.warn('[useTextEdit] located commit failed:', result.error)
            // Fall through to dom-only (don't run project-wide search when we
            // know the file but the write failed — better to show the locator).
          }

          // 0 matches near the line, or commit failed: open SourceLocatorPanel
          // with this file already selected (payload.sourceFile is passed through).
          const locatedDebug = located.debugInfo
          setSaveResult({
            status: 'dom-only',
            retryPayload: payload,
            debugInfo: {
              originalText: payload.oldText,
              normalizedText: locatedDebug?.normalizedSearchText ?? payload.oldText.trim(),
              filesScanned: locatedDebug?.filesScanned ?? 1,
              extensions: locatedDebug?.extensionsSearched ?? [],
              projectPath: project.path,
              strategy: locatedDebug?.strategy ?? 'none',
              sourceFile: locatedDebug?.sourceFile ?? payload.sourceFile,
              originalLine: locatedDebug?.originalLine ?? payload.sourceLine,
              searchedFromLine: locatedDebug?.searchedFromLine,
              searchedToLine: locatedDebug?.searchedToLine,
              oldTextSent: payload.oldText,
              newTextSent: payload.newText,
              editedTagName: payload.editedTagName,
              editedTextContentSample: payload.editedTextContentSample,
              editedElementHasChildren: payload.editedElementHasChildren,
            },
          })
          scheduleClear(30_000)
          return 'dom-only'
        }

        // ── 1. find all source matches ─────────────────────────────────────
        console.log('[useTextEdit] using located edit: false → project-wide search', {
          old: payload.oldText.slice(0, 60),
          new: payload.newText.slice(0, 60),
          projectPath: project.path,
        })

        // Check for a stored mapping — boosts confidence of the previously-linked file
        let preferredFile: string | undefined
        if (payload.tagName && payload.oldText.trim()) {
          const key = buildElementKey(payload.tagName, payload.id, payload.classList)
          if (key && key !== payload.tagName) {  // non-trivial key
            try {
              const mapping = await window.api.getElementMapping({ projectPath: project.path, key })
              if (mapping) {
                preferredFile = mapping.filePath
                console.log('[useTextEdit] found mapping for', key, '→', mapping.filePath)
              }
            } catch { /* mapping store not available — continue */ }
          }
        }

        const analysis = await withTimeout(
          window.api.analyzeTextEdit({
            projectPath:   project.path,
            oldText:       payload.oldText,
            newText:       payload.newText,
            tagName:       payload.tagName || undefined,
            id:            payload.id ?? undefined,
            classList:     payload.classList,
            parentText:    payload.parentText ?? undefined,
            preferredFile,
          }),
          SAVE_TIMEOUT_MS,
          'analyzeTextEdit'
        )

        console.log(
          `[useTextEdit] analyzeTextEdit returned: ${analysis.matchCount} match(es)`,
          analysis.matches.map((m) => `${m.filePath}:${m.lineNumber}`)
        )

        // ── 2a. 0 matches — DOM-only ───────────────────────────────────────
        if (analysis.matchCount === 0) {
          const di = analysis.debugInfo
          console.log('[useTextEdit] 0 matches → dom-only', di)
          setSaveResult({
            status: 'dom-only',
            retryPayload: payload,
            debugInfo: di
              ? {
                  originalText:   payload.oldText,
                  normalizedText: di.normalizedSearchText ?? analysis.oldText,
                  filesScanned:   di.filesScanned ?? 0,
                  extensions:     di.extensionsSearched ?? [],
                  projectPath:    di.projectPath ?? project.path,
                  strategy:       di.strategy ?? 'none',
                  oldTextSent: payload.oldText,
                  newTextSent: payload.newText,
                  editedTagName: payload.editedTagName,
                  editedTextContentSample: payload.editedTextContentSample,
                  editedElementHasChildren: payload.editedElementHasChildren,
                }
              : undefined,
          })
          scheduleClear(30_000)
          return 'dom-only'
        }

        // ── 2b. 1 high-confidence match — auto-commit ─────────────────────
        if (analysis.matchCount === 1 && !analysis.needsConfirmation) {
          const match = analysis.matches[0]
          console.log(
            '[useTextEdit] 1 match → committing to', match.filePath,
            'line', match.lineNumber, 'strategy', match.matchStrategy
          )

          const result = await withTimeout(
            window.api.commitTextEdit({
              filePath:        match.filePath,
              oldText:         analysis.oldText,
              newText:         analysis.newText,
              actualMatchText: match.actualMatchText,
              matchOffset:     match.matchOffset,
            }),
            SAVE_TIMEOUT_MS,
            'commitTextEdit'
          )

          console.log('[useTextEdit] commitTextEdit result:', result)

          if (result.success && result.filePath) {
            setSaveResult({
              status:       'saved',
              filePath:     result.filePath,
              relativePath: toRelative(result.filePath, project.path),
              lineNumber:   result.lineNumber,
            })
            scheduleClear(10_000)
            return 'saved'
          }

          // Write call returned success=false (non-throw failure)
          const writeError = result.error ?? 'Write returned success=false with no error message'
          console.warn('[useTextEdit] commitTextEdit failed:', writeError)
          setSaveResult({ status: 'failed', error: writeError, retryPayload: payload })
          scheduleClear(30_000)
          return 'failed'
        }

        // ── 2c. N matches — needs confirmation ────────────────────────────
        console.log(`[useTextEdit] ${analysis.matchCount} matches → needs-confirmation`)
        setPendingAnalysis(analysis)
        setSaveResult({ status: 'needs-confirmation' })
        return 'needs-confirmation'

      } catch (err) {
        // ── any thrown error (IPC failure, timeout, serialization, etc.) ──
        const error = err instanceof Error ? err.message : String(err)
        console.error('[useTextEdit] handleTextSaved caught error:', error)
        setSaveResult({ status: 'failed', error, retryPayload: payload })
        scheduleClear(30_000)
        return 'failed'
      }
    },
    [project]
  )

  // ── user confirms a specific file from MatchConfirmPanel ─────────────────

  const handleConfirmMatch = useCallback(
    async (match: SourceMatch): Promise<void> => {
      if (!pendingAnalysis) return
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current)

      const retryPayload: TextEditPayload = {
        tagName: '',
        oldText: pendingAnalysis.oldText,
        newText: pendingAnalysis.newText,
      }

      setSaveResult({ status: 'saving' })

      try {
        console.log('[useTextEdit] handleConfirmMatch → commitTextEdit', match.filePath)

        const result = await withTimeout(
          window.api.commitTextEdit({
            filePath:        match.filePath,
            oldText:         pendingAnalysis.oldText,
            newText:         pendingAnalysis.newText,
            actualMatchText: match.actualMatchText,
            matchOffset:     match.matchOffset,
          }),
          SAVE_TIMEOUT_MS,
          'commitTextEdit (confirm)'
        )

        console.log('[useTextEdit] confirmed commit result:', result)
        setPendingAnalysis(null)

        if (result.success && result.filePath) {
          setSaveResult({
            status:       'saved',
            filePath:     result.filePath,
            relativePath: toRelative(result.filePath, project?.path),
            lineNumber:   result.lineNumber,
          })
          scheduleClear(10_000)
        } else {
          const writeError = result.error ?? 'Write returned success=false'
          setSaveResult({ status: 'failed', error: writeError, retryPayload })
          scheduleClear(30_000)
        }

      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        console.error('[useTextEdit] handleConfirmMatch caught error:', error)
        setPendingAnalysis(null)
        setSaveResult({ status: 'failed', error, retryPayload })
        scheduleClear(30_000)
      }
    },
    [pendingAnalysis, project]
  )

  // ── user cancels the match-confirmation panel ────────────────────────────

  const handleCancelConfirmation = useCallback(() => {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
    const analysis = pendingAnalysis
    setPendingAnalysis(null)
    setSaveResult({
      status: 'dom-only',
      retryPayload: analysis
        ? { tagName: '', oldText: analysis.oldText, newText: analysis.newText }
        : undefined,
    })
    scheduleClear(30_000)
  }, [pendingAnalysis])

  // ── manual commit (Source Locator) ───────────────────────────────────────

  const handleManualCommit = useCallback(
    async (match: SourceMatch, newText: string): Promise<CommitResult> => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
      setSaveResult({ status: 'saving' })
      try {
        const result = await withTimeout(
          window.api.commitTextEdit({
            filePath:        match.filePath,
            oldText:         match.actualMatchText,
            newText:         newText.trim(),
            actualMatchText: match.actualMatchText,
            matchOffset:     match.matchOffset,
          }),
          SAVE_TIMEOUT_MS,
          'commitTextEdit (manual)'
        )
        if (result.success && result.filePath) {
          setSaveResult({
            status:       'saved',
            filePath:     result.filePath,
            relativePath: toRelative(result.filePath, project?.path),
            lineNumber:   result.lineNumber,
          })
          scheduleClear(10_000)
        } else {
          setSaveResult({ status: 'failed', error: result.error })
          scheduleClear(30_000)
        }
        return result
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        setSaveResult({ status: 'failed', error })
        scheduleClear(30_000)
        return { success: false, error }
      }
    },
    [project]
  )

  // ── manual retry ─────────────────────────────────────────────────────────

  const retryLastSave = useCallback(async (): Promise<void> => {
    const payload = saveResult.retryPayload
    if (!payload || !payload.oldText) {
      console.log('[useTextEdit] retryLastSave: no retry payload')
      return
    }
    console.log('[useTextEdit] retrying save…')
    await handleTextSaved(payload)
  }, [saveResult.retryPayload, handleTextSaved])

  // ── explicit dismiss ─────────────────────────────────────────────────────

  const dismissSaveResult = useCallback((): void => {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
    setSaveResult(IDLE)
  }, [])

  return {
    saveStatus,
    saveResult,
    pendingAnalysis,
    handleTextSaved,
    handleConfirmMatch,
    handleCancelConfirmation,
    handleManualCommit,
    retryLastSave,
    dismissSaveResult,
  }
}
