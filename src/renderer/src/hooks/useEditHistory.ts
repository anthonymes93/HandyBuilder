import { useCallback, useEffect, useRef, useState } from 'react'
import { Project, HistoryState } from '../types'

const EMPTY_STATE: HistoryState = { entries: [], cursor: 0, canUndo: false, canRedo: false }

export interface HistoryConflict {
  kind: 'undo' | 'redo'
  message: string
  filePath: string
}

export interface UseEditHistoryReturn {
  historyState: HistoryState
  undo: () => Promise<void>
  redo: () => Promise<void>
  refresh: () => Promise<void>
  /** Set when Undo/Redo detected the file on disk no longer matches what history expected. */
  conflict: HistoryConflict | null
  dismissConflict: () => void
  discardConflictFileHistory: () => Promise<void>
  /** Transient "Undid: ..." / "Redid: ..." message. */
  notice: string | null
  dismissNotice: () => void
}

/** Multi-level Undo/Redo — reads/writes edit history for the open project via IPC. */
export function useEditHistory(project: Project | null): UseEditHistoryReturn {
  const [historyState, setHistoryState] = useState<HistoryState>(EMPTY_STATE)
  const [conflict, setConflict] = useState<HistoryConflict | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    if (!project) {
      setHistoryState(EMPTY_STATE)
      return
    }
    try {
      const state = await window.api.getHistoryState({ projectPath: project.path })
      setHistoryState(state)
    } catch (err) {
      console.warn('[useEditHistory] getHistoryState failed:', err)
    }
  }, [project])

  useEffect(() => {
    refresh()
  }, [refresh])

  const showNotice = useCallback((msg: string) => {
    setNotice(msg)
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => setNotice(null), 4_000)
  }, [])

  useEffect(() => () => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
  }, [])

  const undo = useCallback(async () => {
    if (!project) return
    const result = await window.api.undoHistory({ projectPath: project.path })
    setHistoryState(result.state)
    if (result.success) {
      showNotice(`Undid: ${result.description ?? 'edit'}`)
    } else if (result.conflict && result.filePath) {
      setConflict({ kind: 'undo', message: result.error ?? 'File changed outside HandyBuilder.', filePath: result.filePath })
    } else if (result.error) {
      showNotice(result.error)
    }
  }, [project, showNotice])

  const redo = useCallback(async () => {
    if (!project) return
    const result = await window.api.redoHistory({ projectPath: project.path })
    setHistoryState(result.state)
    if (result.success) {
      showNotice(`Redid: ${result.description ?? 'edit'}`)
    } else if (result.conflict && result.filePath) {
      setConflict({ kind: 'redo', message: result.error ?? 'File changed outside HandyBuilder.', filePath: result.filePath })
    } else if (result.error) {
      showNotice(result.error)
    }
  }, [project, showNotice])

  const dismissConflict = useCallback(() => setConflict(null), [])

  const discardConflictFileHistory = useCallback(async () => {
    if (!project || !conflict) return
    const state = await window.api.discardFileHistory({ projectPath: project.path, filePath: conflict.filePath })
    setHistoryState(state)
    setConflict(null)
  }, [project, conflict])

  const dismissNotice = useCallback(() => setNotice(null), [])

  return { historyState, undo, redo, refresh, conflict, dismissConflict, discardConflictFileHistory, notice, dismissNotice }
}
