import { CheckCircle2, AlertTriangle, XCircle, Loader2, AlertCircle } from 'lucide-react'
import { SaveStatus } from '../../types'

interface SaveStatusBadgeProps {
  status: SaveStatus
}

const CONFIG: Record<
  Exclude<SaveStatus, 'idle'>,
  { icon: React.ReactNode; label: string; className: string }
> = {
  saving: {
    icon: <Loader2 className="w-3 h-3 animate-spin" />,
    label: 'Saving…',
    className: 'text-gray-400 bg-gray-800'
  },
  saved: {
    icon: <CheckCircle2 className="w-3 h-3" />,
    label: 'Saved',
    className: 'text-green-400 bg-green-950/60 border border-green-900'
  },
  'dom-only': {
    icon: <AlertTriangle className="w-3 h-3" />,
    label: 'Preview only',
    className: 'text-yellow-400 bg-yellow-950/60 border border-yellow-900'
  },
  'needs-confirmation': {
    icon: <AlertCircle className="w-3 h-3" />,
    label: 'Choose file →',
    className: 'text-orange-400 bg-orange-950/60 border border-orange-900 animate-pulse'
  },
  failed: {
    icon: <XCircle className="w-3 h-3" />,
    label: 'Save failed',
    className: 'text-red-400 bg-red-950/60 border border-red-900'
  }
}

export function SaveStatusBadge({ status }: SaveStatusBadgeProps) {
  if (status === 'idle') return null

  const { icon, label, className } = CONFIG[status]

  return (
    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium ${className}`}>
      {icon}
      {label}
    </div>
  )
}
