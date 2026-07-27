import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Pencil, Copy, Trash2, ChevronRight } from 'lucide-react'
import { DeletionCandidate, DeletionTarget } from '../../types'

interface ElementContextMenuProps {
  /** Position relative to the same offset parent the menu itself mounts in. */
  x: number
  y: number
  /** The DEFAULT deletion target — the deepest safe candidate under the cursor. */
  target: DeletionTarget
  /** Which entry of `candidates` `target` came from; null when no candidate resolved and `target` is the smart-selection fallback. */
  activeCandidateId: string | null
  bounds: { width: number; height: number }
  /** Full deepest-to-outermost fiber-walk chain from the exact clicked node. */
  candidates: DeletionCandidate[]
  onDelete: () => void
  onClose: () => void
  /** `null` clears the preview outline. */
  onPreviewCandidate: (candidateId: string | null) => void
  onSelectCandidate: (candidateId: string) => void
}

/** Floating right-click menu — Edit/Duplicate are disabled placeholders; only Delete is implemented. */
export function ElementContextMenu({
  x, y, target, activeCandidateId, bounds, candidates, onDelete, onClose, onPreviewCandidate, onSelectCandidate,
}: ElementContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [submenuOpen, setSubmenuOpen] = useState(false)

  const activeIndex = activeCandidateId ? candidates.findIndex((c) => c.candidateId === activeCandidateId) : -1
  const activeCandidate = activeIndex >= 0 ? candidates[activeIndex] : null
  // Richer than target.displayLabel (which is bare "<tag>") — includes text
  // preview / component name, e.g. `LeafIcon` or `<span> "Saunders Landscaping"`.
  const activeLabel = activeCandidate?.displayLabel ?? target.displayLabel
  // Everything shallower than the active candidate — true ancestors, offered
  // as "Delete parent ▸" so the user can still reach them without the
  // default action ever silently deleting more than what's under the cursor.
  const parentCandidates = activeIndex >= 0 ? candidates.slice(activeIndex + 1) : candidates

  // Note: the destructive preview outline on `activeCandidateId` is NOT
  // cleared on unmount here — it's meant to persist into the confirm dialog
  // that opens right after (same target). The caller (PreviewPanel) owns
  // clearing it once the whole menu→confirm flow actually ends.

  // Keep the menu fully inside the preview pane.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) { setPos({ x, y }); return }
    const rect = el.getBoundingClientRect()
    const nx = Math.max(4, Math.min(x, bounds.width - rect.width - 4))
    const ny = Math.max(4, Math.min(y, bounds.height - rect.height - 4))
    setPos({ x: nx, y: ny })
  }, [x, y, bounds.width, bounds.height])

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocMouseDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      style={{ position: 'absolute', left: pos.x, top: pos.y }}
      className="z-[100] w-48 rounded-md border border-gray-700 bg-gray-900 py-1 text-[12px] shadow-2xl"
    >
      <div className="mb-1 border-b border-gray-800 px-3 py-1.5 truncate">
        <span className="font-mono text-gray-300">{activeLabel}</span>
        <span className="ml-1 text-gray-600">· {target.displaySource}</span>
      </div>

      <button
        disabled
        title="Not implemented yet"
        className="flex w-full cursor-not-allowed items-center gap-2 px-3 py-1.5 text-left text-gray-600"
      >
        <Pencil className="h-3.5 w-3.5" /> Edit
      </button>
      <button
        disabled
        title="Not implemented yet"
        className="flex w-full cursor-not-allowed items-center gap-2 px-3 py-1.5 text-left text-gray-600"
      >
        <Copy className="h-3.5 w-3.5" /> Duplicate
      </button>

      <div className="my-1 border-t border-gray-800" />

      <button
        onClick={onDelete}
        disabled={target.isProtected}
        title={target.isProtected ? target.protectedReason ?? undefined : undefined}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-400 transition-colors hover:bg-red-950/40 disabled:cursor-not-allowed disabled:text-gray-600 disabled:hover:bg-transparent"
      >
        <Trash2 className="h-3.5 w-3.5" /> Delete {activeLabel}
      </button>
      {target.isProtected && target.protectedReason && (
        <p className="px-3 pt-1 text-[10px] leading-snug text-gray-600">{target.protectedReason}</p>
      )}

      {parentCandidates.length > 0 && (
        <div
          className="relative"
          onMouseEnter={() => setSubmenuOpen(true)}
          onMouseLeave={() => setSubmenuOpen(false)}
        >
          <button
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-400 transition-colors hover:bg-gray-800 ${submenuOpen ? 'bg-gray-800' : ''}`}
          >
            <span className="h-3.5 w-3.5" /> Delete parent
            <ChevronRight className="ml-auto h-3.5 w-3.5 text-gray-600" />
          </button>
          {submenuOpen && (
            <div className="absolute left-full top-0 z-[101] max-h-72 w-56 overflow-y-auto rounded-md border border-gray-700 bg-gray-900 py-1 shadow-2xl">
              {parentCandidates.map((c) => (
                <button
                  key={c.candidateId}
                  onMouseEnter={() => onPreviewCandidate(c.candidateId)}
                  onMouseLeave={() => onPreviewCandidate(activeCandidateId)}
                  onClick={() => {
                    onPreviewCandidate(null)
                    onSelectCandidate(c.candidateId)
                  }}
                  disabled={c.target.isProtected}
                  title={c.target.isProtected ? c.target.protectedReason ?? undefined : undefined}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:text-gray-600 disabled:hover:bg-transparent"
                >
                  <Trash2 className="h-3 w-3 shrink-0 opacity-60" />
                  <span className="truncate font-mono text-[12px] text-gray-200">{c.displayLabel}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
