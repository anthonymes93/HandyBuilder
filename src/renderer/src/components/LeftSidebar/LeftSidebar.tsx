import { useState, useEffect, useCallback, useRef } from 'react'
import { FolderOpen, Search, X, ChevronLeft, ChevronRight, Files, Hammer } from 'lucide-react'
import { Project, FileNode } from '../../types'
import { FileTree } from './FileTree'

const MIN_WIDTH     = 220
const MAX_WIDTH     = 520
const DEFAULT_WIDTH = 280
const COLLAPSED_W   = 48

const LS_WIDTH     = 'hb-sidebar-width'
const LS_COLLAPSED = 'hb-sidebar-collapsed'

interface LeftSidebarProps {
  project: Project | null
  fileTree: FileNode[]
  isLoading: boolean
  onOpenProject: () => void
}

export function LeftSidebar({ project, fileTree, isLoading, onOpenProject }: LeftSidebarProps) {
  const [searchQuery, setSearchQuery] = useState('')

  const [width, setWidth] = useState<number>(() => {
    try {
      const v = localStorage.getItem(LS_WIDTH)
      if (v) { const n = parseInt(v, 10); if (n >= MIN_WIDTH && n <= MAX_WIDTH) return n }
    } catch {}
    return DEFAULT_WIDTH
  })

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_COLLAPSED) === 'true' } catch { return false }
  })

  const [isDragging, setIsDragging] = useState(false)

  // Refs so drag callbacks never become stale
  const widthRef     = useRef(width)
  const collapsedRef = useRef(collapsed)
  useEffect(() => { widthRef.current     = width     }, [width])
  useEffect(() => { collapsedRef.current = collapsed }, [collapsed])

  const toggleCollapse = useCallback(() => {
    setCollapsed((c) => {
      const next = !c
      try { localStorage.setItem(LS_COLLAPSED, String(next)) } catch {}
      return next
    })
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (collapsedRef.current) return
    e.preventDefault()

    const startX     = e.clientX
    const startWidth = widthRef.current
    let   lastWidth  = startWidth

    // Electron <webview> elements absorb mouse events even when a CSS overlay sits above
    // them. Temporarily disable pointer events on all webviews for the duration of the drag.
    const webviews = document.querySelectorAll<HTMLElement>('webview')
    webviews.forEach((wv) => { wv.style.pointerEvents = 'none' })

    setIsDragging(true)

    const onMove = (me: MouseEvent) => {
      lastWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + me.clientX - startX))
      setWidth(lastWidth)
    }

    const onUp = () => {
      setIsDragging(false)
      webviews.forEach((wv) => { wv.style.pointerEvents = '' })
      try { localStorage.setItem(LS_WIDTH, String(lastWidth)) } catch {}
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
  }, [])

  const handleDoubleClick = useCallback(() => {
    if (collapsedRef.current) return
    setWidth(DEFAULT_WIDTH)
    try { localStorage.setItem(LS_WIDTH, String(DEFAULT_WIDTH)) } catch {}
  }, [])

  // ── Collapsed rail ────────────────────────────────────────────────────────────

  if (collapsed) {
    return (
      <div
        className="flex flex-col items-center bg-gray-900 border-r border-gray-800 shrink-0 py-2 gap-0.5"
        style={{ width: COLLAPSED_W }}
      >
        <div className="w-8 h-8 flex items-center justify-center text-gray-700">
          <Hammer className="w-4 h-4" />
        </div>

        <div className="w-6 h-px bg-gray-800 my-1" />

        <button
          onClick={onOpenProject}
          disabled={isLoading}
          title="Open Project"
          className="w-8 h-8 flex items-center justify-center rounded text-gray-500 hover:text-white hover:bg-gray-800 transition-colors disabled:opacity-40"
        >
          <FolderOpen className="w-4 h-4" />
        </button>

        <button
          onClick={toggleCollapse}
          title="Files"
          className="w-8 h-8 flex items-center justify-center rounded text-gray-500 hover:text-white hover:bg-gray-800 transition-colors"
        >
          <Files className="w-4 h-4" />
        </button>

        <div className="flex-1" />

        <button
          onClick={toggleCollapse}
          title="Expand sidebar"
          className="w-8 h-8 flex items-center justify-center rounded text-gray-600 hover:text-gray-300 hover:bg-gray-800 transition-colors"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    )
  }

  // ── Expanded sidebar ──────────────────────────────────────────────────────────

  return (
    <>
      {/* Full-viewport overlay while dragging so the webview can't swallow mouse events */}
      {isDragging && (
        <div className="fixed inset-0 z-50" style={{ cursor: 'col-resize' }} />
      )}

      <div
        className="relative flex flex-col bg-gray-900 border-r border-gray-800 shrink-0"
        style={{ width }}
      >
        {/* Header row: Open Project + Collapse toggle */}
        <div className="p-2.5 border-b border-gray-800 flex items-center gap-1.5">
          <button
            onClick={onOpenProject}
            disabled={isLoading}
            className="flex-1 min-w-0 flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white text-sm rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <FolderOpen className="w-4 h-4 shrink-0" />
            <span className="truncate">{isLoading ? 'Opening…' : 'Open Project'}</span>
          </button>

          <button
            onClick={toggleCollapse}
            title="Collapse sidebar"
            className="shrink-0 w-7 h-7 flex items-center justify-center rounded text-gray-600 hover:text-gray-300 hover:bg-gray-800 transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        </div>

        {/* Search */}
        {project && (
          <div className="px-2 py-1.5 border-b border-gray-800">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-600 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search files…"
                className="w-full bg-gray-800 text-gray-300 text-xs placeholder-gray-600 pl-8 pr-7 py-1.5 rounded border border-gray-700 focus:border-blue-500 focus:outline-none transition-colors"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* File tree */}
        <div className="flex-1 overflow-y-auto">
          {!project ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 p-6">
              <FolderOpen className="w-10 h-10 text-gray-800" />
              <p className="text-gray-700 text-xs text-center leading-relaxed">
                Open a project folder to browse files
              </p>
            </div>
          ) : (
            <FileTree nodes={fileTree} searchQuery={searchQuery} />
          )}
        </div>

        {/* Resize handle — right edge, 6 px grab area */}
        <div
          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize group"
          onMouseDown={handleMouseDown}
          onDoubleClick={handleDoubleClick}
        >
          <div className="absolute inset-y-0 right-0 w-px bg-transparent group-hover:bg-blue-500/50 transition-colors duration-150" />
        </div>
      </div>
    </>
  )
}
