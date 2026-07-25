import { RotateCcw } from 'lucide-react'

interface NumberUnitControlProps {
  label: string
  value: string
  onChange: (v: string) => void
  onReset?: () => void
  units?: string[]
  allowAuto?: boolean
}

function splitValue(v: string, allowAuto?: boolean): { num: string; unit: string } {
  const trimmed = v.trim()
  if (allowAuto && trimmed === 'auto') return { num: '', unit: 'auto' }
  const m = /^(-?\d*\.?\d+)([a-z%]*)$/i.exec(trimmed)
  if (m) return { num: m[1], unit: m[2] || 'px' }
  return { num: '', unit: 'px' }
}

/** Compact number + unit-dropdown control (px / % / em / rem / auto…). */
export function NumberUnitControl({
  label, value, onChange, onReset, units = ['px', '%', 'em', 'rem'], allowAuto,
}: NumberUnitControlProps) {
  const { num, unit } = splitValue(value, allowAuto)
  const allUnits = allowAuto ? ['auto', ...units] : units

  function setNum(n: string) {
    if (unit === 'auto') { onChange(n === '' ? 'auto' : `${n}px`); return }
    onChange(n === '' ? '' : `${n}${unit}`)
  }
  function setUnit(u: string) {
    if (u === 'auto') { onChange('auto'); return }
    onChange(num ? `${num}${u}` : `0${u}`)
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-gray-600 w-16 shrink-0">{label}</span>
      <input
        type="number"
        value={unit === 'auto' ? '' : num}
        disabled={unit === 'auto'}
        onChange={(e) => setNum(e.target.value)}
        className="w-14 bg-gray-800 border border-gray-700 focus:border-blue-500 focus:outline-none rounded px-1.5 py-1 text-[10px] text-gray-200 font-mono disabled:opacity-40 transition-colors"
      />
      <select
        value={unit}
        onChange={(e) => setUnit(e.target.value)}
        className="bg-gray-800 border border-gray-700 rounded px-1 py-1 text-[10px] text-gray-400"
      >
        {allUnits.map((u) => <option key={u || 'none'} value={u}>{u || '—'}</option>)}
      </select>
      {onReset && (
        <button onClick={onReset} title="Reset" className="text-gray-700 hover:text-gray-300 shrink-0 ml-auto transition-colors">
          <RotateCcw className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}
