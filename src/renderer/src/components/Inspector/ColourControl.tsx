import { RotateCcw } from 'lucide-react'

interface ColourControlProps {
  label: string
  value: string
  onChange: (v: string) => void
  onReset?: () => void
}

/**
 * Colour swatch + native OS colour picker + free-text field (hex/rgb/rgba/hsl/
 * CSS var()/transparent all accepted as raw text — the browser resolves them
 * natively for the swatch background, so no CSS colour parser is needed here).
 * The native <input type="color"> is OS-rendered chrome, so it can never open
 * behind the Electron window the way a custom JS popover could.
 */
function toHexForPicker(value: string): string {
  const v = value.trim()
  if (/^#[0-9a-f]{6}$/i.test(v)) return v
  if (/^#[0-9a-f]{3}$/i.test(v)) return '#' + v.slice(1).split('').map((c) => c + c).join('')
  const m = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
  if (m) return '#' + [1, 2, 3].map((i) => parseInt(m[i], 10).toString(16).padStart(2, '0')).join('')
  return '#000000'
}

export function ColourControl({ label, value, onChange, onReset }: ColourControlProps) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-gray-600 w-16 shrink-0">{label}</span>
      <div
        className="relative w-5 h-5 shrink-0 rounded border border-gray-700 overflow-hidden"
        style={{
          background: value && value !== 'transparent'
            ? value
            : 'repeating-linear-gradient(45deg,#444 0,#444 2px,transparent 0,transparent 6px)',
        }}
      >
        <input
          type="color"
          value={toHexForPicker(value)}
          onChange={(e) => onChange(e.target.value)}
          title="Pick a colour"
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        />
      </div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="#hex, rgb(), var(--x)…"
        className="flex-1 min-w-0 bg-gray-800 border border-gray-700 focus:border-blue-500 focus:outline-none rounded px-1.5 py-1 text-[10px] text-gray-200 font-mono transition-colors"
      />
      {onReset && (
        <button onClick={onReset} title="Reset" className="text-gray-700 hover:text-gray-300 shrink-0 transition-colors">
          <RotateCcw className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}
