import { useEffect, useRef, useState } from 'react'
import { History as HistoryIcon } from 'lucide-react'
import { HistoryState, HistoryEditType } from '../../types'

const TYPE_LABEL: Record<HistoryEditType, string> = {
  text: 'Text',
  image: 'Image',
  link: 'Link',
  style: 'Style',
  'ast-binding': 'Text',
  'manual-edit': 'Manual',
  delete: 'Delete',
}

function timeAgo(ts: number): string {
  const diffMs = Date.now() - ts
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return new Date(ts).toLocaleDateString()
}

interface HistoryPanelProps {
  historyState: HistoryState
}

/** Compact, informational dropdown of recent edits — newest first. Entries are not yet clickable. */
export function HistoryPanel({ historyState }: HistoryPanelProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onOutsideClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onOutsideClick)
    return () => document.removeEventListener('mousedown', onOutsideClick)
  }, [open])

  const { entries, cursor } = historyState

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Edit history"
        className={[
          'flex items-center gap-1.5 px-3 py-1.5 text-xs rounded transition-colors',
          open ? 'bg-gray-800 text-gray-100' : 'text-gray-400 hover:text-gray-100 hover:bg-gray-800',
        ].join(' ')}
      >
        <HistoryIcon className="w-3.5 h-3.5" />
        History
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-80 max-h-96 overflow-y-auto rounded border border-gray-700 bg-gray-900 shadow-2xl z-50">
          {entries.length === 0 ? (
            <p className="px-3 py-4 text-xs text-gray-600 text-center">No edits yet</p>
          ) : (
            <ul className="divide-y divide-gray-800/80">
              {entries.map((e, i) => {
                // entries are newest-first; cursor counts applied edits from the oldest.
                const originalIndex = entries.length - 1 - i
                const isApplied = originalIndex < cursor
                return (
                  <li
                    key={e.id}
                    className={`px-3 py-2 text-xs ${isApplied ? 'text-gray-300' : 'text-gray-600 opacity-60'}`}
                    title={e.filePath}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium truncate">{e.description}</span>
                      <span className="shrink-0 text-[10px] text-gray-600">{TYPE_LABEL[e.editType]}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-0.5 text-[10px] text-gray-600">
                      <span className="font-mono truncate">{e.filePath.split('/').pop()}</span>
                      <span className="shrink-0">{timeAgo(e.timestamp)}</span>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
