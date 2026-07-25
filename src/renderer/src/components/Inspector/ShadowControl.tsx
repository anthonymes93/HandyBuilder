import { ColourControl } from './ColourControl'

interface ShadowControlProps {
  /** Full CSS box-shadow string, e.g. "0px 4px 8px 0px rgba(0,0,0,0.25)", or ''/'none'. */
  value: string
  onChange: (v: string) => void
  onReset?: () => void
}

interface ShadowParts { x: string; y: string; blur: string; spread: string; color: string }

function parseShadow(v: string): ShadowParts {
  const m = /(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+(.+)/.exec(v)
  if (m) return { x: m[1], y: m[2], blur: m[3], spread: m[4], color: m[5].trim() }
  return { x: '0', y: '0', blur: '0', spread: '0', color: 'rgba(0,0,0,0.25)' }
}

function buildShadow(p: ShadowParts): string {
  return `${p.x || 0}px ${p.y || 0}px ${p.blur || 0}px ${p.spread || 0}px ${p.color}`
}

/** Compact box-shadow editor: x / y / blur / spread number fields + a colour control. */
export function ShadowControl({ value, onChange, onReset }: ShadowControlProps) {
  const parsed = parseShadow(value && value !== 'none' ? value : '')

  function set(key: keyof ShadowParts, v: string) {
    onChange(buildShadow({ ...parsed, [key]: v }))
  }

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-4 gap-1">
        {(['x', 'y', 'blur', 'spread'] as const).map((k) => (
          <div key={k}>
            <p className="text-[9px] text-gray-600 mb-0.5 capitalize">{k}</p>
            <input
              type="number"
              value={parsed[k]}
              onChange={(e) => set(k, e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 focus:border-blue-500 focus:outline-none rounded px-1 py-1 text-[10px] text-gray-200 font-mono transition-colors"
            />
          </div>
        ))}
      </div>
      <ColourControl label="Colour" value={parsed.color} onChange={(v) => set('color', v)} onReset={onReset} />
    </div>
  )
}
