import { Monitor, RotateCw, ExternalLink, MousePointer2, Stethoscope } from 'lucide-react'
import { Project, DevServerStatus, SaveStatus } from '../../types'
import { SaveStatusBadge } from '../Editor/SaveStatusBadge'

interface ToolbarProps {
  project: Project | null
  devServerStatus: DevServerStatus
  devServerUrl: string | null
  isInspectMode: boolean
  saveStatus: SaveStatus
  onReload: () => void
  onOpenInBrowser: () => void
  onToggleInspect: () => void
  onCheckHbInjection: () => void
}

const STATUS_DOT: Record<DevServerStatus, string> = {
  idle: 'bg-gray-600',
  installing: 'bg-yellow-500 animate-pulse',
  starting: 'bg-yellow-500 animate-pulse',
  running: 'bg-green-500',
  stopped: 'bg-gray-600',
  error: 'bg-red-500'
}

const STATUS_LABEL: Record<DevServerStatus, string> = {
  idle: 'Idle',
  installing: 'Installing…',
  starting: 'Starting…',
  running: 'Running',
  stopped: 'Stopped',
  error: 'Error'
}

export function Toolbar({
  project,
  devServerStatus,
  devServerUrl,
  isInspectMode,
  saveStatus,
  onReload,
  onOpenInBrowser,
  onToggleInspect,
  onCheckHbInjection
}: ToolbarProps) {
  return (
    <div className="h-11 flex items-center gap-2 px-4 bg-gray-900 border-b border-gray-800 shrink-0">
      <Monitor className="w-4 h-4 text-blue-400 shrink-0" />
      <span className="text-blue-400 font-semibold text-sm shrink-0 mr-1">HandyBuilder</span>

      <div className="w-px h-5 bg-gray-800 shrink-0" />

      <div className="flex-1 min-w-0 px-2">
        {project ? (
          <span className="text-gray-500 text-xs font-mono truncate block" title={project.path}>
            {project.path}
          </span>
        ) : (
          <span className="text-gray-700 text-xs">No project open</span>
        )}
      </div>

      {/* Save status — visible whenever there's something to report */}
      <SaveStatusBadge status={saveStatus} />

      {project && (
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-gray-800/60 border border-gray-700/50">
          <div className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[devServerStatus]}`} />
          <span className="text-xs text-gray-400">{STATUS_LABEL[devServerStatus]}</span>
        </div>
      )}

      <button
        onClick={onToggleInspect}
        disabled={!devServerUrl}
        title={isInspectMode ? 'Disable Inspect mode' : 'Enable Inspect mode'}
        className={[
          'flex items-center gap-1.5 px-3 py-1.5 text-xs rounded transition-colors',
          'disabled:opacity-30 disabled:cursor-not-allowed',
          isInspectMode
            ? 'bg-blue-600 text-white hover:bg-blue-500'
            : 'text-gray-400 hover:text-gray-100 hover:bg-gray-800'
        ].join(' ')}
      >
        <MousePointer2 className="w-3.5 h-3.5" />
        Inspect
      </button>

      <div className="w-px h-5 bg-gray-800 shrink-0" />

      <button
        onClick={onCheckHbInjection}
        disabled={!devServerUrl}
        title="Check HandyBuilder source metadata injection"
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-amber-300 hover:text-amber-200 hover:bg-gray-800 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <Stethoscope className="w-3.5 h-3.5" />
        Check HB Injection
      </button>

      <button
        onClick={onReload}
        disabled={!project}
        title="Reload Preview"
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-400 hover:text-gray-100 hover:bg-gray-800 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <RotateCw className="w-3.5 h-3.5" />
        Reload
      </button>

      <button
        onClick={onOpenInBrowser}
        disabled={!devServerUrl}
        title="Open in Browser"
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-400 hover:text-gray-100 hover:bg-gray-800 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <ExternalLink className="w-3.5 h-3.5" />
        Open in Browser
      </button>
    </div>
  )
}
