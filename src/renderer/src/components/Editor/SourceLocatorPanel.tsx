import type { ChangeEvent, ReactNode } from 'react'
import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import {
  Search, FileCode, ExternalLink, Save, X, Loader2, AlertCircle,
  ChevronLeft, FolderOpen, CheckCircle2, FileSearch
} from 'lucide-react'
import { TextEditPayload, SourceMatch, CommitResult, FileNode } from '../../types'
import { useSourceLocator } from '../../hooks/useSourceLocator'

// ─── types ────────────────────────────────────────────────────────────────────

type PanelMode = 'search' | 'file-pick' | 'line-pick'

interface FileEntry {
  path: string
  relPath: string
  name: string
}

interface LineEntry {
  lineNumber: number
  text: string
  offset: number
}

// ─── props ────────────────────────────────────────────────────────────────────

interface SourceLocatorPanelProps {
  payload: TextEditPayload
  projectPath: string
  fileTree: FileNode[]
  onSave: (match: SourceMatch, newText: string) => Promise<CommitResult>
  onOpenFile: (filePath: string) => void
  onClose: () => void
}

// ─── helpers ──────────────────────────────────────────────────────────────────

const SOURCE_EXTS = new Set([
  'tsx', 'ts', 'jsx', 'js', 'html', 'htm', 'css', 'scss', 'sass',
  'vue', 'svelte', 'astro', 'json', 'md', 'mdx', 'yaml', 'yml', 'xml', 'svg',
])

function relPath(filePath: string, projectPath: string): string {
  const prefix = projectPath.endsWith('/') ? projectPath : projectPath + '/'
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath
}

function flattenTree(nodes: FileNode[], projectPath: string): FileEntry[] {
  const out: FileEntry[] = []
  function walk(list: FileNode[]) {
    for (const node of list) {
      if (node.type === 'file') {
        const ext = node.name.split('.').pop()?.toLowerCase() ?? ''
        if (SOURCE_EXTS.has(ext)) {
          out.push({ path: node.path, relPath: relPath(node.path, projectPath), name: node.name })
        }
      } else if (node.children) {
        walk(node.children)
      }
    }
  }
  walk(nodes)
  return out
}

function computeLines(content: string): LineEntry[] {
  const lines = content.split('\n')
  const out: LineEntry[] = []
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    out.push({ lineNumber: i + 1, text: lines[i], offset })
    offset += lines[i].length + 1
  }
  return out
}

function buildChips(payload: TextEditPayload): string[] {
  const chips = new Set<string>()
  const old = payload.oldText.trim()

  const words = old.split(/\s+/).filter((w) => w.length >= 4)
  if (words.length > 1) words.slice(0, 4).forEach((w) => chips.add(w))

  payload.classList?.forEach((c) => { if (c) chips.add(c) })
  if (payload.id) chips.add(`#${payload.id}`)

  if (payload.href) {
    const path = payload.href.replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '')
    if (path && path.length > 1) chips.add(path.slice(0, 40))
  }

  if (payload.parentText) {
    payload.parentText.trim().split(/\s+/)
      .filter((w) => w.length >= 4)
      .slice(0, 2)
      .forEach((w) => chips.add(w))
  }

  chips.delete(old)
  return [...chips].slice(0, 8)
}

// ─── sub-components ───────────────────────────────────────────────────────────

function ConfidencePill({ confidence, strategy }: { confidence: number; strategy: string }): ReactNode {
  if (strategy === 'jsx-word-proximity' || confidence < 50)
    return <span className="text-[9px] px-1.5 py-0.5 rounded bg-yellow-900/50 text-yellow-400">possible</span>
  if (confidence >= 80)
    return <span className="text-[9px] px-1.5 py-0.5 rounded bg-green-900/50 text-green-400">exact</span>
  return <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-400">flexible</span>
}

function ResultCard({
  match, projectPath, newText, disabled, onSave, onOpenFile,
}: {
  match: SourceMatch
  projectPath: string
  newText: string
  disabled: boolean
  onSave: (m: SourceMatch) => void
  onOpenFile: (filePath: string) => void
}): ReactNode {
  const rel = relPath(match.filePath, projectPath)
  const afterLine = match.lineText.includes(match.actualMatchText)
    ? match.lineText.replace(match.actualMatchText, newText)
    : newText

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-gray-800/60">
        <FileCode className="w-3 h-3 text-blue-400 shrink-0" />
        <span className="flex-1 min-w-0 text-[11px] font-mono text-gray-300 truncate" title={match.filePath}>
          {rel}
        </span>
        <span className="text-[10px] text-gray-600 shrink-0">:{match.lineNumber}</span>
        <ConfidencePill confidence={match.confidence} strategy={match.matchStrategy} />
      </div>

      <div className="bg-gray-950 font-mono text-[10px]">
        {match.contextBefore.trim() && (
          <div className="px-2 py-0.5 text-gray-700 truncate">{match.contextBefore.trimStart()}</div>
        )}
        <div className="flex gap-1.5 px-2 py-0.5 bg-red-950/40 text-red-300">
          <span className="shrink-0 opacity-50">−</span>
          <span className="truncate">{match.lineText.trimStart()}</span>
        </div>
        <div className="flex gap-1.5 px-2 py-0.5 bg-green-950/40 text-green-300">
          <span className="shrink-0 opacity-50">+</span>
          <span className="truncate">{afterLine.trimStart()}</span>
        </div>
        {match.contextAfter.trim() && (
          <div className="px-2 py-0.5 text-gray-700 truncate">{match.contextAfter.trimStart()}</div>
        )}
      </div>

      <div className="flex gap-1.5 px-2.5 py-2 border-t border-gray-800 bg-gray-900">
        <button
          onClick={() => onOpenFile(match.filePath)}
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded transition-colors"
          title="Open in default editor"
        >
          <ExternalLink className="w-3 h-3" />
          Open
        </button>
        <button
          disabled={disabled}
          onClick={() => onSave(match)}
          className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-[11px] bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded transition-colors"
        >
          <Save className="w-3 h-3" />
          Save here
        </button>
      </div>
    </div>
  )
}

function SearchChips({ chips, onChipClick }: { chips: string[]; onChipClick: (c: string) => void }): ReactNode {
  if (!chips.length) return null
  return (
    <div className="mt-3">
      <p className="text-[10px] text-gray-700 mb-1.5">Try searching for:</p>
      <div className="flex flex-wrap gap-1">
        {chips.map((chip) => (
          <button
            key={chip}
            onClick={() => onChipClick(chip)}
            className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 font-mono transition-colors border border-gray-700"
          >
            {chip}
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── panel ────────────────────────────────────────────────────────────────────

export function SourceLocatorPanel({
  payload, projectPath, fileTree, onSave, onOpenFile, onClose,
}: SourceLocatorPanelProps) {
  const [mode,        setMode]        = useState<PanelMode>('search')
  const [saving,      setSaving]      = useState(false)
  const [saveError,   setSaveError]   = useState<string | null>(null)
  const [savedAt,     setSavedAt]     = useState<{ file: string; line: number } | null>(null)

  // file-pick state
  const [fileFilter,  setFileFilter]  = useState('')

  // line-pick state
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null)
  const [fileLines,    setFileLines]    = useState<LineEntry[]>([])
  const [lineFilter,   setLineFilter]   = useState('')
  const [selectedLine, setSelectedLine] = useState<LineEntry | null>(null)
  const [loadingFile,  setLoadingFile]  = useState(false)
  const [fileReadError, setFileReadError] = useState<string | null>(null)

  const { query, setQuery, results, analysis, isSearching, searchError } = useSourceLocator(
    projectPath,
    payload
  )

  const newText  = payload.newText.trim()
  const oldText  = payload.oldText.trim()
  const chips    = useMemo(() => buildChips(payload), [payload])
  const allFiles = useMemo(() => flattenTree(fileTree, projectPath), [fileTree, projectPath])

  const lineListRef = useRef<HTMLDivElement>(null)

  const filteredFiles = useMemo(() => {
    const q = fileFilter.trim().toLowerCase()
    return q ? allFiles.filter((f) => f.relPath.toLowerCase().includes(q)) : allFiles
  }, [allFiles, fileFilter])

  const filteredLines = useMemo(() => {
    const q = lineFilter.trim().toLowerCase()
    return q ? fileLines.filter((l) => l.text.toLowerCase().includes(q)) : fileLines
  }, [fileLines, lineFilter])

  // ── navigation ─────────────────────────────────────────────────────────────

  const goToFilePick = useCallback(() => {
    setMode('file-pick')
    setFileFilter('')
    setSaveError(null)
  }, [])

  const goToSearch = useCallback(() => {
    setMode('search')
    setSaveError(null)
  }, [])

  const goToLinePick = useCallback(async (entry: FileEntry) => {
    setSelectedFile(entry)
    setSelectedLine(null)
    setLineFilter('')
    setFileLines([])
    setFileReadError(null)
    setLoadingFile(true)
    setMode('line-pick')

    try {
      const result = await window.api.readProjectFile({ filePath: entry.path, projectPath })
      if ('error' in result) {
        const msg = (result as { error: string }).error
        setFileReadError(msg)
        console.error('[SourceLocatorPanel] readProjectFile error:', msg)
      } else {
        setFileLines(computeLines((result as { content: string }).content))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setFileReadError(msg)
      console.error('[SourceLocatorPanel] readProjectFile threw:', err)
    } finally {
      setLoadingFile(false)
    }
  }, [projectPath])

  // When source metadata is present, skip the search mode and jump directly to
  // line-pick for the known file. Runs once on mount.
  useEffect(() => {
    if (!payload.sourceFile) return
    const entry: FileEntry = {
      path:    payload.sourceFile,
      relPath: relPath(payload.sourceFile, projectPath),
      name:    payload.sourceFile.split('/').pop() ?? payload.sourceFile,
    }
    goToLinePick(entry)
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // After line-pick loads, scroll to the target line when sourceLine is set.
  useEffect(() => {
    if (mode !== 'line-pick' || !payload.sourceLine || fileLines.length === 0 || !lineListRef.current) return
    const fraction = (payload.sourceLine - 1) / fileLines.length
    lineListRef.current.scrollTop = fraction * lineListRef.current.scrollHeight
  }, [mode, fileLines, payload.sourceLine])

  // ── save handlers ──────────────────────────────────────────────────────────

  const handleAutoSave = useCallback(async (match: SourceMatch) => {
    setSaving(true)
    setSaveError(null)
    try {
      const result = await onSave(match, newText)
      if (result.success) {
        setSavedAt({ file: relPath(match.filePath, projectPath), line: match.lineNumber })
        setTimeout(onClose, 1800)
      } else {
        const msg = result.error ?? 'Save failed with no error message'
        setSaveError(msg)
        console.error('[SourceLocatorPanel] auto save failed:', msg)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setSaveError(msg)
      console.error('[SourceLocatorPanel] auto save threw:', err)
    } finally {
      setSaving(false)
    }
  }, [onSave, newText, projectPath, onClose])

  const handleManualSave = useCallback(async () => {
    if (!selectedFile || !selectedLine) return
    setSaving(true)
    setSaveError(null)

    const lineText = selectedLine.text
    const exactIdx = lineText.indexOf(oldText)

    let matchOffset: number
    let actualMatchText: string

    if (exactIdx >= 0) {
      matchOffset     = selectedLine.offset + exactIdx
      actualMatchText = oldText
    } else {
      // Whole-line replacement (user explicitly chose this line despite no exact match)
      matchOffset     = selectedLine.offset
      actualMatchText = lineText
    }

    const match: SourceMatch = {
      filePath:        selectedFile.path,
      lineNumber:      selectedLine.lineNumber,
      lineText,
      contextBefore:   fileLines[selectedLine.lineNumber - 2]?.text ?? '',
      contextAfter:    fileLines[selectedLine.lineNumber]?.text ?? '',
      matchOffset,
      matchStrategy:   'exact',
      actualMatchText,
      confidence:      90,
    }

    try {
      const result = await onSave(match, newText)
      if (result.success) {
        setSavedAt({ file: selectedFile.relPath, line: selectedLine.lineNumber })
        setTimeout(onClose, 1800)
      } else {
        const msg = result.error ?? 'Save failed with no error message'
        setSaveError(msg)
        console.error('[SourceLocatorPanel] manual save failed:', msg)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setSaveError(msg)
      console.error('[SourceLocatorPanel] manual save threw:', err)
    } finally {
      setSaving(false)
    }
  }, [selectedFile, selectedLine, fileLines, oldText, newText, onSave, onClose])

  // ── line-pick helpers ──────────────────────────────────────────────────────

  const lineHasMatch = selectedLine ? selectedLine.text.includes(oldText) : false

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <div className="w-60 flex flex-col bg-gray-900 border-l-2 border-blue-600 shrink-0 overflow-hidden">

      {/* ── header ── */}
      <div className="h-9 flex items-center justify-between px-3 bg-blue-950/40 border-b border-blue-700/40 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {mode !== 'search' ? (
            <button
              onClick={mode === 'line-pick' ? () => setMode('file-pick') : goToSearch}
              className="text-blue-400 hover:text-blue-200 transition-colors shrink-0"
              title="Back"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
          ) : (
            <FileSearch className="w-3.5 h-3.5 text-blue-400 shrink-0" />
          )}
          <span className="text-blue-300 text-[11px] font-medium uppercase tracking-widest truncate">
            {mode === 'search'    ? 'Find source for edit' :
             mode === 'file-pick' ? 'Pick a file' :
             selectedFile?.name ?? 'File view'}
          </span>
        </div>
        <button
          onClick={onClose}
          className="text-gray-600 hover:text-gray-300 transition-colors shrink-0 ml-1"
          title="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* ── old → new summary ── */}
      <div className="px-3 py-1.5 border-b border-gray-800 bg-gray-950/50 shrink-0">
        <div className="flex items-baseline gap-1.5 font-mono text-[10px] leading-snug">
          <span className="text-gray-600 shrink-0">was:</span>
          <span className="text-red-400 truncate" title={oldText}>"{oldText}"</span>
        </div>
        <div className="flex items-baseline gap-1.5 font-mono text-[10px] leading-snug">
          <span className="text-gray-600 shrink-0">now:</span>
          <span className="text-green-400 truncate" title={newText}>"{newText}"</span>
        </div>
      </div>

      {/* ── save error banner ── */}
      {saveError && !savedAt && (
        <div className="mx-2 mt-2 px-2 py-1.5 bg-red-950 border border-red-700 rounded text-[10px] text-red-300 flex gap-1.5 items-start shrink-0">
          <AlertCircle className="w-3 h-3 text-red-400 shrink-0 mt-px" />
          <span className="break-all">{saveError}</span>
        </div>
      )}

      {/* ── saved overlay ── */}
      {savedAt ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 p-4">
          <CheckCircle2 className="w-8 h-8 text-green-400" />
          <p className="text-green-400 text-xs font-medium">Saved!</p>
          <p className="text-gray-600 text-[10px] font-mono text-center break-all">
            {savedAt.file}:{savedAt.line}
          </p>
        </div>
      ) : (
        <>
          {/* ══ MODE: search ══ */}
          {mode === 'search' && (
            <>
              {/* search input */}
              <div className="px-2.5 pt-2 pb-1.5 border-b border-gray-800 shrink-0">
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-600 pointer-events-none" />
                  <input
                    type="text"
                    value={query}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
                    placeholder="Search project…"
                    className="w-full bg-gray-800 border border-gray-700 focus:border-blue-500 focus:outline-none rounded pl-6 pr-2 py-1.5 text-[11px] text-gray-200 transition-colors"
                    autoFocus
                  />
                </div>
              </div>

              {/* results area */}
              <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
                {(isSearching || saving) ? (
                  <div className="flex items-center justify-center gap-2 py-8">
                    <Loader2 className="w-4 h-4 text-gray-600 animate-spin" />
                    <span className="text-gray-600 text-[11px]">{saving ? 'Saving…' : 'Searching…'}</span>
                  </div>
                ) : searchError ? (
                  <div className="flex flex-col gap-2 py-4 px-1">
                    <div className="flex items-start gap-1.5 px-2 py-1.5 bg-red-950 border border-red-700 rounded text-[10px] text-red-300">
                      <AlertCircle className="w-3 h-3 shrink-0 mt-px" />
                      <span className="break-all">{searchError}</span>
                    </div>
                    <SearchChips chips={chips} onChipClick={setQuery} />
                  </div>
                ) : results.length > 0 ? (
                  results.map((match, i) => (
                    <ResultCard
                      key={`${match.filePath}:${match.lineNumber}:${i}`}
                      match={match}
                      projectPath={projectPath}
                      newText={newText}
                      disabled={saving}
                      onSave={handleAutoSave}
                      onOpenFile={onOpenFile}
                    />
                  ))
                ) : query.trim() ? (
                  <div className="flex flex-col items-center py-5 px-2 text-center">
                    <AlertCircle className="w-5 h-5 text-gray-700 mb-2" />
                    <p className="text-gray-500 text-[11px] mb-0.5">No automatic matches found</p>
                    {analysis?.debugInfo && (
                      <p className="text-gray-700 text-[10px]">
                        Scanned {analysis.debugInfo.filesScanned} files.
                      </p>
                    )}
                    <SearchChips chips={chips} onChipClick={setQuery} />
                  </div>
                ) : (
                  <div className="flex flex-col items-center py-5 px-2 text-center">
                    <Search className="w-5 h-5 text-gray-800 mb-2" />
                    <p className="text-gray-700 text-[11px]">Searching project…</p>
                    <SearchChips chips={chips} onChipClick={setQuery} />
                  </div>
                )}
              </div>

              {/* manual file pick CTA */}
              <div className="px-2 py-2 border-t border-gray-800 shrink-0">
                <button
                  onClick={goToFilePick}
                  className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11px] text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded border border-gray-700 hover:border-gray-600 transition-colors"
                >
                  <FolderOpen className="w-3 h-3" />
                  Open file and save manually
                </button>
              </div>
            </>
          )}

          {/* ══ MODE: file-pick ══ */}
          {mode === 'file-pick' && (
            <>
              <div className="px-2.5 py-2 border-b border-gray-800 shrink-0">
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-600 pointer-events-none" />
                  <input
                    type="text"
                    value={fileFilter}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setFileFilter(e.target.value)}
                    placeholder="Filter files…"
                    className="w-full bg-gray-800 border border-gray-700 focus:border-blue-500 focus:outline-none rounded pl-6 pr-2 py-1.5 text-[11px] text-gray-200 transition-colors"
                    autoFocus
                  />
                </div>
                <p className="mt-1 text-[10px] text-gray-700">Click a file to view its lines</p>
              </div>

              <div className="flex-1 overflow-y-auto">
                {filteredFiles.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 py-8 text-center px-3">
                    <FolderOpen className="w-5 h-5 text-gray-800" />
                    <p className="text-gray-700 text-[11px]">
                      {fileFilter ? 'No files match your filter.' : 'No source files found.'}
                    </p>
                  </div>
                ) : (
                  filteredFiles.map((entry) => (
                    <button
                      key={entry.path}
                      onClick={() => goToLinePick(entry)}
                      className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-gray-800 border-b border-gray-800/50 transition-colors"
                    >
                      <FileCode className="w-3 h-3 text-gray-600 shrink-0" />
                      <span className="text-[10px] font-mono text-gray-400 truncate" title={entry.relPath}>
                        {entry.relPath}
                      </span>
                    </button>
                  ))
                )}
              </div>

              <div className="px-2 py-2 border-t border-gray-800 shrink-0">
                <button
                  onClick={goToSearch}
                  className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11px] text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded transition-colors"
                >
                  <ChevronLeft className="w-3 h-3" />
                  Back to search
                </button>
              </div>
            </>
          )}

          {/* ══ MODE: line-pick ══ */}
          {mode === 'line-pick' && selectedFile && (
            <>
              {/* file info + line filter */}
              <div className="px-2.5 py-2 border-b border-gray-800 shrink-0">
                <div className="flex items-center gap-1 mb-1.5">
                  <FileCode className="w-3 h-3 text-blue-400 shrink-0" />
                  <span className="text-[10px] font-mono text-blue-300 truncate" title={selectedFile.relPath}>
                    {selectedFile.relPath}
                  </span>
                </div>
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-600 pointer-events-none" />
                  <input
                    type="text"
                    value={lineFilter}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setLineFilter(e.target.value)}
                    placeholder="Filter lines…"
                    className="w-full bg-gray-800 border border-gray-700 focus:border-blue-500 focus:outline-none rounded pl-6 pr-2 py-1.5 text-[11px] text-gray-200 transition-colors"
                    autoFocus
                  />
                </div>
                {!lineFilter && oldText && (
                  <p className="mt-1 text-[10px] text-gray-700">
                    <span className="text-yellow-600">Yellow</span> lines contain your text. Click to select.
                  </p>
                )}
              </div>

              {/* line list or loading/error */}
              {loadingFile ? (
                <div className="flex-1 flex items-center justify-center gap-2">
                  <Loader2 className="w-4 h-4 text-gray-600 animate-spin" />
                  <span className="text-gray-600 text-[11px]">Loading…</span>
                </div>
              ) : fileReadError ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-2 p-4">
                  <div className="flex items-start gap-1.5 px-2 py-1.5 bg-red-950 border border-red-700 rounded text-[10px] text-red-300 w-full">
                    <AlertCircle className="w-3 h-3 shrink-0 mt-px" />
                    <span className="break-all">{fileReadError}</span>
                  </div>
                  <button
                    onClick={() => goToLinePick(selectedFile)}
                    className="text-[11px] text-gray-500 hover:text-gray-300"
                  >
                    Retry
                  </button>
                </div>
              ) : (
                <div ref={lineListRef} className="flex-1 overflow-y-auto font-mono">
                  {filteredLines.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-2 py-8 text-center px-3">
                      <p className="text-gray-700 text-[11px]">
                        {lineFilter ? 'No lines match.' : 'File is empty.'}
                      </p>
                    </div>
                  ) : (
                    filteredLines.map((line) => {
                      const hasOld    = line.text.includes(oldText)
                      const isSelected = selectedLine?.lineNumber === line.lineNumber
                      return (
                        <div
                          key={line.lineNumber}
                          onClick={() => setSelectedLine(line)}
                          className={[
                            'flex gap-1.5 px-2 py-px cursor-pointer hover:bg-gray-800/70 transition-colors',
                            isSelected ? 'bg-blue-900/50 border-l-2 border-blue-500' : 'border-l-2 border-transparent',
                          ].join(' ')}
                        >
                          <span className="text-[9px] text-gray-700 select-none w-7 shrink-0 text-right pt-px">
                            {line.lineNumber}
                          </span>
                          <span className={[
                            'text-[10px] truncate',
                            hasOld      ? 'text-yellow-300' :
                            isSelected  ? 'text-gray-300' :
                                          'text-gray-600',
                          ].join(' ')}>
                            {line.text || ' '}
                          </span>
                        </div>
                      )
                    })
                  )}
                </div>
              )}

              {/* save button footer */}
              {!loadingFile && !fileReadError && (
                <div className="px-2 py-2 border-t border-gray-800 shrink-0">
                  {selectedLine && !lineHasMatch && (
                    <p className="text-[10px] text-yellow-600 mb-1.5 leading-tight">
                      ⚠ Old text not in this line — full line will be replaced
                    </p>
                  )}
                  {!selectedLine && (
                    <p className="text-[10px] text-gray-700 mb-1.5">Click a line above to select it.</p>
                  )}
                  <button
                    disabled={!selectedLine || saving}
                    onClick={handleManualSave}
                    className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11px] bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded transition-colors"
                  >
                    {saving
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : <Save className="w-3 h-3" />
                    }
                    Replace {selectedLine && lineHasMatch ? 'selected text' : 'selected line'} with my edit
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
