import { useState } from 'react'
import { Link2, RotateCcw } from 'lucide-react'

type Side = 'Top' | 'Right' | 'Bottom' | 'Left'

interface LinkedSpacingControlProps {
  label: string
  top: string
  right: string
  bottom: string
  left: string
  onChange: (side: Side, value: string) => void
  onReset?: () => void
}

/** Padding/margin 4-side control — defaults to a single linked value, with a chain icon to unlink sides. */
export function LinkedSpacingControl({ label, top, right, bottom, left, onChange, onReset }: LinkedSpacingControlProps) {
  const allEqual = top === right && right === bottom && bottom === left
  const [linked, setLinked] = useState(allEqual)

  function setAll(v: string) {
    (['Top', 'Right', 'Bottom', 'Left'] as const).forEach((s) => onChange(s, v))
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-gray-600">{label}</span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setLinked((v) => !v)}
            title={linked ? 'Unlink sides' : 'Link sides'}
            className={`p-0.5 rounded transition-colors ${linked ? 'text-blue-400' : 'text-gray-600 hover:text-gray-400'}`}
          >
            <Link2 className="w-3 h-3" />
          </button>
          {onReset && (
            <button onClick={onReset} title="Reset" className="text-gray-700 hover:text-gray-300 transition-colors">
              <RotateCcw className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {linked ? (
        <input
          type="text"
          value={top}
          onChange={(e) => setAll(e.target.value)}
          placeholder="0px"
          className="w-full bg-gray-800 border border-gray-700 focus:border-blue-500 focus:outline-none rounded px-2 py-1 text-[10px] text-gray-200 font-mono transition-colors"
        />
      ) : (
        <div className="grid grid-cols-2 gap-1">
          {([['T', top, 'Top'], ['R', right, 'Right'], ['B', bottom, 'Bottom'], ['L', left, 'Left']] as const).map(
            ([short, val, side]) => (
              <div key={side} className="flex items-center gap-1">
                <span className="text-[9px] text-gray-600 w-3 shrink-0">{short}</span>
                <input
                  type="text"
                  value={val}
                  onChange={(e) => onChange(side, e.target.value)}
                  className="flex-1 min-w-0 bg-gray-800 border border-gray-700 focus:border-blue-500 focus:outline-none rounded px-1.5 py-1 text-[10px] text-gray-200 font-mono transition-colors"
                />
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}
