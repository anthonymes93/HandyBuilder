import { useState } from 'react'
import { Link2, RotateCcw } from 'lucide-react'

type Corner = 'TL' | 'TR' | 'BR' | 'BL'

interface BorderControlProps {
  width: string
  style: string
  radiusTL: string
  radiusTR: string
  radiusBR: string
  radiusBL: string
  onWidthChange: (v: string) => void
  onStyleChange: (v: string) => void
  onRadiusChange: (corner: Corner, v: string) => void
  onResetWidth?: () => void
  onResetRadius?: () => void
}

const BORDER_STYLES = ['solid', 'dashed', 'dotted', 'none']

export function BorderControl({
  width, style, radiusTL, radiusTR, radiusBR, radiusBL,
  onWidthChange, onStyleChange, onRadiusChange, onResetWidth, onResetRadius,
}: BorderControlProps) {
  const allEqual = radiusTL === radiusTR && radiusTR === radiusBR && radiusBR === radiusBL
  const [perCorner, setPerCorner] = useState(!allEqual)

  function setAllCorners(v: string) {
    (['TL', 'TR', 'BR', 'BL'] as const).forEach((c) => onRadiusChange(c, v))
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-gray-600 w-16 shrink-0">Width</span>
        <input
          type="text"
          value={width}
          onChange={(e) => onWidthChange(e.target.value)}
          placeholder="1px"
          className="w-14 bg-gray-800 border border-gray-700 focus:border-blue-500 focus:outline-none rounded px-1.5 py-1 text-[10px] text-gray-200 font-mono transition-colors"
        />
        <select
          value={style}
          onChange={(e) => onStyleChange(e.target.value)}
          className="flex-1 bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[10px] text-gray-400"
        >
          {BORDER_STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {onResetWidth && (
          <button onClick={onResetWidth} title="Reset" className="text-gray-700 hover:text-gray-300 transition-colors">
            <RotateCcw className="w-3 h-3" />
          </button>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-gray-600">Radius</span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setPerCorner((v) => !v)}
              title={perCorner ? 'Use one linked radius' : 'Edit each corner separately'}
              className={`p-0.5 rounded transition-colors ${perCorner ? 'text-blue-400' : 'text-gray-600 hover:text-gray-400'}`}
            >
              <Link2 className="w-3 h-3" />
            </button>
            {onResetRadius && (
              <button onClick={onResetRadius} title="Reset" className="text-gray-700 hover:text-gray-300 transition-colors">
                <RotateCcw className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
        {!perCorner ? (
          <input
            type="text"
            value={radiusTL}
            onChange={(e) => setAllCorners(e.target.value)}
            placeholder="0px"
            className="w-full bg-gray-800 border border-gray-700 focus:border-blue-500 focus:outline-none rounded px-2 py-1 text-[10px] text-gray-200 font-mono transition-colors"
          />
        ) : (
          <div className="grid grid-cols-2 gap-1">
            {([['TL', radiusTL], ['TR', radiusTR], ['BR', radiusBR], ['BL', radiusBL]] as const).map(([corner, val]) => (
              <div key={corner} className="flex items-center gap-1">
                <span className="text-[9px] text-gray-600 w-5 shrink-0">{corner}</span>
                <input
                  type="text"
                  value={val}
                  onChange={(e) => onRadiusChange(corner, e.target.value)}
                  className="flex-1 min-w-0 bg-gray-800 border border-gray-700 focus:border-blue-500 focus:outline-none rounded px-1.5 py-1 text-[10px] text-gray-200 font-mono transition-colors"
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
