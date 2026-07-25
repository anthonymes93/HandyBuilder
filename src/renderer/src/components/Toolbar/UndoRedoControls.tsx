import { Undo2, Redo2 } from 'lucide-react'
import { HistoryState } from '../../types'

interface UndoRedoControlsProps {
  historyState: HistoryState
  onUndo: () => void
  onRedo: () => void
}

/** Toolbar Undo/Redo buttons — distinct from webview back/forward navigation. */
export function UndoRedoControls({ historyState, onUndo, onRedo }: UndoRedoControlsProps) {
  const { canUndo, canRedo, undoDescription, redoDescription } = historyState

  return (
    <div className="flex items-center">
      <button
        onClick={onUndo}
        disabled={!canUndo}
        title={canUndo ? `Undo: ${undoDescription} (Ctrl+Z)` : 'Nothing to undo'}
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-400 hover:text-gray-100 hover:bg-gray-800 rounded-l transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <Undo2 className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={onRedo}
        disabled={!canRedo}
        title={canRedo ? `Redo: ${redoDescription} (Ctrl+Shift+Z / Ctrl+Y)` : 'Nothing to redo'}
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-400 hover:text-gray-100 hover:bg-gray-800 rounded-r transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <Redo2 className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
