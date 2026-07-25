import { StyleProps } from '../../types'
import { NumberUnitControl } from './NumberUnitControl'

interface TypographyControlsProps {
  values: StyleProps
  onChange: (key: keyof StyleProps, value: string) => void
}

const FONT_WEIGHTS = ['100', '200', '300', '400', '500', '600', '700', '800', '900']
const TEXT_ALIGNS = ['left', 'center', 'right', 'justify']
const TEXT_TRANSFORMS = ['none', 'uppercase', 'lowercase', 'capitalize']
const TEXT_DECORATIONS = ['none', 'underline', 'line-through']

export function TypographyControls({ values, onChange }: TypographyControlsProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-gray-600 w-16 shrink-0">Font</span>
        <input
          type="text"
          value={values.fontFamily ?? ''}
          onChange={(e) => onChange('fontFamily', e.target.value)}
          placeholder="Inter, sans-serif"
          className="flex-1 min-w-0 bg-gray-800 border border-gray-700 focus:border-blue-500 focus:outline-none rounded px-1.5 py-1 text-[10px] text-gray-200 font-mono transition-colors"
        />
      </div>

      <NumberUnitControl label="Size" value={values.fontSize ?? ''} onChange={(v) => onChange('fontSize', v)} />

      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-gray-600 w-16 shrink-0">Weight</span>
        <select
          value={values.fontWeight ?? '400'}
          onChange={(e) => onChange('fontWeight', e.target.value)}
          className="flex-1 bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[10px] text-gray-200"
        >
          {FONT_WEIGHTS.map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
      </div>

      <NumberUnitControl label="Line height" value={values.lineHeight ?? ''} onChange={(v) => onChange('lineHeight', v)} units={['', 'px', 'em']} />
      <NumberUnitControl label="Letter spc." value={values.letterSpacing ?? ''} onChange={(v) => onChange('letterSpacing', v)} units={['px', 'em']} />

      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-gray-600 w-16 shrink-0">Align</span>
        <div className="grid grid-cols-4 gap-0.5 flex-1">
          {TEXT_ALIGNS.map((a) => (
            <button
              key={a}
              onClick={() => onChange('textAlign', a)}
              title={a}
              className={`py-1 text-[9px] rounded border capitalize transition-colors ${
                values.textAlign === a
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600'
              }`}
            >
              {a.slice(0, 1).toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-gray-600 w-16 shrink-0">Transform</span>
        <select
          value={values.textTransform ?? 'none'}
          onChange={(e) => onChange('textTransform', e.target.value)}
          className="flex-1 bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[10px] text-gray-200"
        >
          {TEXT_TRANSFORMS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-gray-600 w-16 shrink-0">Decoration</span>
        <select
          value={values.textDecoration ?? 'none'}
          onChange={(e) => onChange('textDecoration', e.target.value)}
          className="flex-1 bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[10px] text-gray-200"
        >
          {TEXT_DECORATIONS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
    </div>
  )
}
