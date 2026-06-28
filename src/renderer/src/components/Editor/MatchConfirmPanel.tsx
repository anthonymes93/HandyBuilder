import type { ReactNode } from 'react'
import { AlertCircle, AlertTriangle, FileCode, X } from 'lucide-react'
import { TextEditAnalysis, SourceMatch } from '../../types'

interface MatchConfirmPanelProps {
  analysis: TextEditAnalysis
  projectPath: string
  onConfirm: (match: SourceMatch) => void
  onCancel: () => void
}

function relPath(filePath: string, projectPath: string): string {
  const prefix = projectPath.endsWith('/') ? projectPath : projectPath + '/'
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath
}

// ─── confidence badge ─────────────────────────────────────────────────────────

function ConfidenceBadge({ confidence, strategy }: { confidence: number; strategy: string }) {
  if (strategy === 'jsx-word-proximity' || confidence < 50) {
    return (
      <span className="text-[9px] px-1 py-0.5 rounded bg-yellow-900/50 text-yellow-400/90 shrink-0">
        possible
      </span>
    )
  }
  if (confidence >= 80) {
    return (
      <span className="text-[9px] px-1 py-0.5 rounded bg-green-900/50 text-green-400/90 shrink-0">
        exact
      </span>
    )
  }
  return (
    <span className="text-[9px] px-1 py-0.5 rounded bg-blue-900/40 text-blue-400/90 shrink-0">
      flexible
    </span>
  )
}

// ─── diff lines ───────────────────────────────────────────────────────────────

function DiffLine({ prefix, content, color }: { prefix: string; content: string; color: string }) {
  return (
    <div className={`flex gap-1.5 px-2 py-0.5 font-mono text-[10px] leading-relaxed ${color}`}>
      <span className="shrink-0 select-none opacity-60">{prefix}</span>
      <span className="truncate">{content.trimStart()}</span>
    </div>
  )
}

function ContextLine({ content }: { content: string }) {
  if (!content.trim()) return null
  return (
    <div className="px-2 py-0.5 font-mono text-[10px] text-gray-700 leading-relaxed truncate">
      {content.trimStart()}
    </div>
  )
}

// ─── match card ───────────────────────────────────────────────────────────────

function MatchCard({
  match, analysis, projectPath, onConfirm,
}: {
  match: SourceMatch
  analysis: TextEditAnalysis
  projectPath: string
  onConfirm: (m: SourceMatch) => void
}): ReactNode {
  const rel      = relPath(match.filePath, projectPath)
  const afterLine = match.lineText.includes(analysis.oldText)
    ? match.lineText.replace(analysis.oldText, analysis.newText)
    : analysis.newText

  const isLowConf = match.matchStrategy === 'jsx-word-proximity' || match.confidence < 50

  return (
    <div className={`border rounded-lg overflow-hidden ${isLowConf ? 'border-yellow-900/50' : 'border-gray-800'}`}>
      {/* file header */}
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-gray-800/60">
        <div className="flex items-center gap-1.5 min-w-0">
          <FileCode className="w-3 h-3 text-blue-400 shrink-0" />
          <span className="text-[11px] font-mono text-gray-300 truncate" title={match.filePath}>
            {rel}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-[10px] text-gray-600">:{match.lineNumber}</span>
          <ConfidenceBadge confidence={match.confidence} strategy={match.matchStrategy} />
        </div>
      </div>

      {/* diff */}
      <div className="bg-gray-950 border-t border-gray-800">
        <ContextLine content={match.contextBefore} />
        <DiffLine prefix="−" content={match.lineText} color="bg-red-950/40 text-red-300" />
        <DiffLine prefix="+" content={afterLine}      color="bg-green-950/40 text-green-300" />
        <ContextLine content={match.contextAfter} />
      </div>

      {/* action */}
      <div className="px-2.5 py-2 border-t border-gray-800 bg-gray-900">
        <button
          onClick={() => onConfirm(match)}
          className={`w-full px-3 py-1.5 text-white text-xs rounded transition-colors ${
            isLowConf
              ? 'bg-yellow-700 hover:bg-yellow-600 active:bg-yellow-800'
              : 'bg-blue-600 hover:bg-blue-500 active:bg-blue-700'
          }`}
        >
          {isLowConf ? 'Save here (review first)' : 'Save to this file'}
        </button>
      </div>
    </div>
  )
}

// ─── panel ───────────────────────────────────────────────────────────────────

export function MatchConfirmPanel({
  analysis, projectPath, onConfirm, onCancel,
}: MatchConfirmPanelProps) {
  const isLowConfidence = analysis.needsConfirmation === true

  return (
    <div className="w-60 flex flex-col bg-gray-900 border-l border-gray-800 shrink-0 overflow-hidden">
      {/* header */}
      <div className="h-9 flex items-center justify-between px-3 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-2">
          {isLowConfidence
            ? <AlertTriangle className="w-3.5 h-3.5 text-yellow-400" />
            : <AlertCircle className="w-3.5 h-3.5 text-orange-400" />}
          <span className={`text-[11px] font-medium uppercase tracking-widest ${isLowConfidence ? 'text-yellow-400' : 'text-orange-400'}`}>
            {analysis.matchCount} {isLowConfidence ? 'possible' : ''} match{analysis.matchCount !== 1 ? 'es' : ''}
          </span>
        </div>
        <button
          onClick={onCancel}
          title="Keep DOM change, skip saving"
          className="text-gray-700 hover:text-gray-300 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* instructions */}
      <div className={`px-3 py-2 border-b shrink-0 ${isLowConfidence ? 'bg-yellow-950/20 border-yellow-900/40' : 'border-gray-800'}`}>
        {isLowConfidence ? (
          <p className="text-yellow-400/80 text-[11px] leading-relaxed">
            Exact text not found. These locations <em>may</em> contain the source.
            Review the diff before saving.
          </p>
        ) : (
          <p className="text-gray-500 text-[11px] leading-relaxed">
            This text appears in{' '}
            <span className="text-orange-400 font-medium">{analysis.matchCount} locations</span>.
            Choose where to save.
          </p>
        )}
      </div>

      {/* match list */}
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
        {analysis.matches.map((match, i) => (
          <MatchCard
            key={`${match.filePath}:${match.lineNumber}:${i}`}
            match={match}
            analysis={analysis}
            projectPath={projectPath}
            onConfirm={onConfirm}
          />
        ))}
      </div>

      {/* cancel footer */}
      <div className="px-3 py-2 border-t border-gray-800 shrink-0">
        <button
          onClick={onCancel}
          className="w-full px-3 py-1.5 text-gray-500 hover:text-gray-300 text-xs rounded border border-gray-800 hover:border-gray-700 transition-colors"
        >
          Cancel — keep DOM change only
        </button>
      </div>
    </div>
  )
}
