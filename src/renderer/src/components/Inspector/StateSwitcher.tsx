import { StyleState } from '../../types'

interface StateSwitcherProps {
  state: StyleState
  onChange: (s: StyleState) => void
}

/** Normal / Hover state switcher — the live preview follows whichever is active. */
export function StateSwitcher({ state, onChange }: StateSwitcherProps) {
  return (
    <div className="flex mx-3 mt-2 mb-2 rounded bg-gray-800 p-0.5">
      {(['normal', 'hover'] as const).map((s) => (
        <button
          key={s}
          onClick={() => onChange(s)}
          className={[
            'flex-1 py-1 text-[11px] rounded capitalize transition-colors',
            state === s ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200',
          ].join(' ')}
        >
          {s}
        </button>
      ))}
    </div>
  )
}
