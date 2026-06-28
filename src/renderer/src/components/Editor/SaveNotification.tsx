import { useState } from 'react'
import {
  CheckCircle2, AlertTriangle, XCircle, Loader2,
  ExternalLink, FolderOpen, X, RotateCw, ChevronDown, Copy, Check, AlertCircle
} from 'lucide-react'
import { SaveResult } from '../../types'

interface SaveNotificationProps {
  saveResult: SaveResult
  onRetry: () => void
  onDismiss: () => void
  onOpenFile: (filePath: string) => void
  onShowInFolder: (filePath: string) => void
  onOpenSourceLocator: () => void
}

export function SaveNotification({
  saveResult,
  onRetry,
  onDismiss,
  onOpenFile,
  onShowInFolder,
  onOpenSourceLocator,
}: SaveNotificationProps) {
  const { status } = saveResult
  const [debugOpen,    setDebugOpen]    = useState(false)
  const [copied,       setCopied]       = useState(false)
  const [locatorError, setLocatorError] = useState<string | null>(null)

  if (status === 'idle' || status === 'needs-confirmation') return null

  function copyDebug() {
    const d = saveResult.debugInfo
    if (!d) return
    const text = [
      `HandyBuilder — source match debug`,
      ``,
      `Searched text:   ${d.originalText.trim()}`,
      `Normalized text: ${d.normalizedText}`,
      `Strategy tried:  ${d.strategy}`,
      `Files scanned:   ${d.filesScanned}`,
      `Extensions:      ${d.extensions.join(', ')}`,
      `Project path:    ${d.projectPath}`,
      ...(d.sourceFile ? [`Source file:     ${d.sourceFile}`] : []),
      ...(d.originalLine ? [`Original line:   ${d.originalLine}`] : []),
      ...(d.searchedFromLine && d.searchedToLine ? [`Line range:      ${d.searchedFromLine}–${d.searchedToLine}`] : []),
      ...(d.oldTextSent !== undefined ? [`oldText sent:    ${d.oldTextSent}`] : []),
      ...(d.newTextSent !== undefined ? [`newText sent:    ${d.newTextSent}`] : []),
      ...(d.editedTagName ? [`Edited tag:      ${d.editedTagName}`] : []),
      ...(d.editedTextContentSample !== undefined ? [`textContent:     ${d.editedTextContentSample}`] : []),
      ...(d.editedElementHasChildren !== undefined ? [`Has children:    ${d.editedElementHasChildren}`] : []),
    ].join('\n')
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const isDomOnly = status === 'dom-only'
  const hasFail   = status === 'failed'
  const hasSaved  = status === 'saved'

  const barClass = {
    saving: 'bg-gray-900 border-b border-gray-800',
    saved:  'bg-green-950/80 border-b border-green-900/60',
    'dom-only': 'bg-yellow-950/80 border-b border-yellow-900/60',
    failed: 'bg-red-950/80 border-b border-red-900/60',
  }[status]

  const Icon = {
    saving:     <Loader2     className="w-4 h-4 text-gray-400 animate-spin shrink-0" />,
    saved:      <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />,
    'dom-only': <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0" />,
    failed:     <XCircle     className="w-4 h-4 text-red-400 shrink-0" />,
  }[status]

  return (
    <div className={`${barClass} shrink-0 px-4 py-2`}>
      {/* ── main row ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 min-h-[22px]">
        {Icon}

        <span className="flex-1 min-w-0 text-xs">
          {status === 'saving' && (
            <span className="text-gray-400">Saving…</span>
          )}

          {hasSaved && (
            <span className="text-green-200">
              Saved to{' '}
              <span className="font-mono font-semibold">
                {saveResult.relativePath ?? saveResult.filePath ?? 'source file'}
              </span>
              {saveResult.lineNumber !== undefined && (
                <span className="text-green-400/70 ml-1">line {saveResult.lineNumber}</span>
              )}
            </span>
          )}

          {isDomOnly && (() => {
            const triedFile = saveResult.retryPayload?.sourceFile
            const triedLine = saveResult.retryPayload?.sourceLine
            const fname = triedFile?.split('/').pop() ?? triedFile
            const range = saveResult.debugInfo?.searchedFromLine && saveResult.debugInfo?.searchedToLine
              ? `${saveResult.debugInfo.searchedFromLine}–${saveResult.debugInfo.searchedToLine}`
              : null
            return triedFile ? (
              <span className="text-yellow-200">
                Source metadata found — text not found in{' '}
                <span className="font-mono text-yellow-300">{fname}</span>
                {' · original line '}{triedLine ?? '?'}
                {range && <> · expanded range searched {range}</>}
              </span>
            ) : (
              <span className="text-yellow-200">
                Preview updated — source text was not found in project files
              </span>
            )
          })()}

          {hasFail && (
            <span className="text-red-200">
              Save failed
              {saveResult.error && (
                <span className="text-red-400/80 ml-1">
                  — {saveResult.error.slice(0, 100)}
                </span>
              )}
            </span>
          )}
        </span>

        {/* ── action buttons ──────────────────────────────────────────── */}
        <div className="flex items-center gap-1 shrink-0">
          {hasSaved && saveResult.filePath && (
            <>
              <button
                onClick={() => onOpenFile(saveResult.filePath!)}
                className="flex items-center gap-1 px-2 py-1 text-[11px] text-green-400 hover:text-green-200 hover:bg-green-900/40 rounded transition-colors"
                title="Open in default editor"
              >
                <ExternalLink className="w-3 h-3" />
                Open file
              </button>
              <button
                onClick={() => onShowInFolder(saveResult.filePath!)}
                className="flex items-center gap-1 px-2 py-1 text-[11px] text-green-400 hover:text-green-200 hover:bg-green-900/40 rounded transition-colors"
                title="Reveal in file manager"
              >
                <FolderOpen className="w-3 h-3" />
                Show in folder
              </button>
            </>
          )}

          {isDomOnly && (
            <button
              onClick={() => {
                console.log('[SaveNotification] Find in source clicked, retryPayload:', saveResult.retryPayload)
                if (!saveResult.retryPayload) {
                  const msg = 'No edit payload available — try re-editing the element first'
                  console.error('[SaveNotification] Find in source: retryPayload missing!', saveResult)
                  setLocatorError(msg)
                  return
                }
                setLocatorError(null)
                onOpenSourceLocator()
              }}
              className="flex items-center gap-1 px-2 py-1 text-[11px] text-yellow-400/80 hover:text-yellow-200 hover:bg-yellow-900/30 rounded transition-colors"
              title="Open source locator to manually find and save the change"
            >
              <RotateCw className="w-3 h-3" />
              Find in source
            </button>
          )}

          {hasFail && saveResult.retryPayload && (
            <button
              onClick={onRetry}
              className="flex items-center gap-1 px-2 py-1 text-[11px] text-gray-300 hover:text-white hover:bg-gray-700 rounded transition-colors"
              title="Re-run source search"
            >
              <RotateCw className="w-3 h-3" />
              Try again
            </button>
          )}

          {isDomOnly && saveResult.debugInfo && (
            <button
              onClick={() => setDebugOpen((v) => !v)}
              className={`flex items-center gap-0.5 px-2 py-1 text-[11px] rounded transition-colors ${
                debugOpen
                  ? 'text-yellow-300 bg-yellow-900/30'
                  : 'text-yellow-500/70 hover:text-yellow-300 hover:bg-yellow-900/20'
              }`}
              title="Show debug info"
            >
              Debug
              <ChevronDown className={`w-3 h-3 transition-transform ${debugOpen ? 'rotate-180' : ''}`} />
            </button>
          )}

          {status !== 'saving' && (
            <button
              onClick={onDismiss}
              className="p-1 text-gray-600 hover:text-gray-300 rounded transition-colors ml-1"
              title="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* ── locator error ───────────────────────────────────────────────── */}
      {locatorError && (
        <div className="mt-1 ml-7 flex items-center gap-1.5 text-[11px] text-red-300">
          <AlertCircle className="w-3 h-3 text-red-400 shrink-0" />
          {locatorError}
        </div>
      )}

      {/* ── debug panel ─────────────────────────────────────────────────── */}
      {isDomOnly && debugOpen && saveResult.debugInfo && (() => {
        const d = saveResult.debugInfo!
        return (
          <div className="mt-2 ml-7 p-2.5 bg-yellow-950/40 border border-yellow-900/40 rounded text-[10px] font-mono space-y-1">
            <div className="flex justify-between items-start gap-2">
              <div className="space-y-1 min-w-0">
                <div className="text-yellow-400/80">
                  <span className="text-yellow-600">searched: </span>
                  <span className="break-all">"{d.originalText.trim().slice(0, 120)}"</span>
                </div>
                {d.normalizedText !== d.originalText.trim() && (
                  <div className="text-yellow-400/80">
                    <span className="text-yellow-600">normalized: </span>
                    <span className="break-all">"{d.normalizedText.slice(0, 120)}"</span>
                  </div>
                )}
                <div className="text-yellow-500/60">
                  strategy tried: {d.strategy} · files scanned: {d.filesScanned} · extensions: {d.extensions.join(' ')}
                </div>
                <div className="text-yellow-500/50 truncate" title={d.projectPath}>
                  project: {d.projectPath}
                </div>
                {d.sourceFile && (
                  <div className="text-yellow-500/60 break-all">
                    file: {d.sourceFile} · original line: {d.originalLine ?? '?'} · range searched: {d.searchedFromLine ?? '?'}–{d.searchedToLine ?? '?'}
                  </div>
                )}
                {d.oldTextSent !== undefined && (
                  <div className="mt-1 space-y-1 text-yellow-400/80">
                    <div>oldText sent: <span className="break-all">"{d.oldTextSent}"</span></div>
                    <div>newText sent: <span className="break-all">"{d.newTextSent ?? ''}"</span></div>
                    <div>edited tag: {d.editedTagName ?? '?'} · has child elements: {String(d.editedElementHasChildren ?? false)}</div>
                    <div>edited textContent (first 300): <span className="break-all">"{d.editedTextContentSample ?? ''}"</span></div>
                  </div>
                )}
              </div>
              <button
                onClick={copyDebug}
                className="flex items-center gap-1 px-1.5 py-1 text-[10px] text-yellow-500/70 hover:text-yellow-300 hover:bg-yellow-900/40 rounded transition-colors shrink-0"
                title="Copy debug info to clipboard"
              >
                {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
