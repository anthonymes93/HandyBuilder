import { useState, type ReactNode } from 'react'
import { ChevronDown, RotateCcw } from 'lucide-react'

interface StyleAccordionProps {
  title: string
  defaultOpen?: boolean
  onResetSection?: () => void
  children: ReactNode
}

/** Collapsible Inspector section with an optional "Reset section" action. */
export function StyleAccordion({ title, defaultOpen, onResetSection, children }: StyleAccordionProps) {
  const [open, setOpen] = useState(defaultOpen ?? false)

  return (
    <div className="border-b border-gray-800/60">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-800/40 transition-colors"
      >
        <span className="text-[10px] text-gray-500 uppercase tracking-widest font-medium">{title}</span>
        <div className="flex items-center gap-1.5">
          {onResetSection && open && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onResetSection() }}
              title="Reset section"
              className="text-gray-700 hover:text-gray-300 transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
            </span>
          )}
          <ChevronDown className={`w-3 h-3 text-gray-600 transition-transform ${open ? 'rotate-180' : ''}`} />
        </div>
      </button>
      {open && <div className="px-3 pb-3 space-y-2">{children}</div>}
    </div>
  )
}
