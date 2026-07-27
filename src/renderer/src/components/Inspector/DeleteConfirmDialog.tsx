import { useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'
import { DeletionTarget } from '../../types'

interface DeleteConfirmDialogProps {
  target: DeletionTarget
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}

export function DeleteConfirmDialog({ target, busy, error, onCancel, onConfirm }: DeleteConfirmDialogProps) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onCancel, busy])

  const label = target.ownerComponentName ? `<${target.ownerComponentName}>` : target.displayLabel

  // "What remains" — built from the deleted element's actual DOM siblings/
  // container, so this stays accurate for any element, not just the logo
  // example: only the icon removed leaves its sibling text and the link
  // itself untouched; deleting the link itself takes everything with it.
  const remainsParts: string[] = []
  if (target.remainingSiblingLabels.length > 0) {
    remainsParts.push(target.remainingSiblingLabels.join(', '))
  }
  if (target.remainingContainerLabel) {
    remainsParts.push(`the surrounding ${target.remainingContainerLabel}`)
  }
  const remainsText = remainsParts.length > 0
    ? `Only ${label} will be removed. ${remainsParts.join(' and ')} will remain.`
    : `This will remove ${label} and everything nested inside it.`

  return (
    <div
      className="absolute inset-0 z-[200] flex items-center justify-center bg-black/60"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel() }}
    >
      <div className="w-80 rounded-lg border border-gray-700 bg-gray-900 p-4 shadow-2xl">
        <div className="mb-2 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
          <h2 className="text-sm font-semibold text-gray-100">Delete {label}?</h2>
        </div>
        <p className="mb-3 text-[12px] leading-relaxed text-gray-500">
          {remainsText} You can undo this action.
        </p>
        <div className="mb-4 rounded border border-gray-800 bg-gray-950 px-2.5 py-1.5 font-mono text-[11px] text-gray-400 break-all">
          {label} at {target.displaySource}
        </div>

        {error && (
          <div className="mb-3 rounded border border-red-800 bg-red-950/40 px-2.5 py-1.5 text-[11px] text-red-300">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded border border-gray-800 px-3 py-1.5 text-xs text-gray-400 transition-colors hover:border-gray-700 hover:text-gray-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="rounded bg-red-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-red-500 disabled:opacity-50"
          >
            {busy ? 'Deleting…' : 'Delete Element'}
          </button>
        </div>
      </div>
    </div>
  )
}
