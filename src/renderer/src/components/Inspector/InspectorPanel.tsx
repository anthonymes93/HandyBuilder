import type { ReactNode, ChangeEvent } from 'react'
import { useState, useEffect, useRef } from 'react'
import {
  SlidersHorizontal, X, Link2, MousePointerClick, ImageIcon, FolderOpen, AlertTriangle, MapPin
} from 'lucide-react'
import { SelectedElement, InspectorSavePatch, SaveStatus, ImagePickResult, DomPatch } from '../../types'
import { classifyElement, isEditable, ElementKind } from '../../utils/elementKind'
import { SaveStatusBadge } from '../Editor/SaveStatusBadge'

// ─── shared primitives ────────────────────────────────────────────────────────

function shorthand(t: string, r: string, b: string, l: string): string {
  if (t === r && r === b && b === l) return t
  if (t === b && r === l) return `${t} ${r}`
  return `${t} ${r} ${b} ${l}`
}

function isTransparentColor(c: string): boolean {
  return c === 'rgba(0, 0, 0, 0)' || c === 'transparent' || c === ''
}

function ColorSwatch({ color }: { color: string }) {
  const empty = isTransparentColor(color)
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <span
        className="w-3 h-3 rounded border border-gray-600 shrink-0"
        style={
          empty
            ? { backgroundImage: 'repeating-linear-gradient(45deg,#555 0,#555 1px,transparent 0,transparent 50%)', backgroundSize: '4px 4px' }
            : { background: color }
        }
      />
      <span className="text-gray-400 text-[11px] font-mono truncate">{empty ? 'transparent' : color}</span>
    </span>
  )
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-[3px] min-w-0">
      <span className="text-gray-600 text-[11px] shrink-0">{label}</span>
      <span className="text-[11px] text-right min-w-0">{children}</span>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="px-3 py-2 border-b border-gray-800/60">
      <p className="text-[10px] text-gray-700 uppercase tracking-widest mb-1.5 font-medium">{title}</p>
      {children}
    </div>
  )
}

// ─── shared edit field ────────────────────────────────────────────────────────

function EditField({
  label, value, placeholder, onChange,
}: {
  label: string
  value: string
  placeholder?: string
  onChange: (v: string) => void
}) {
  return (
    <div className="mb-2">
      <p className="text-[10px] text-gray-600 mb-1">{label}</p>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 focus:border-blue-500 focus:outline-none rounded px-2 py-1.5 text-[11px] text-gray-200 font-mono transition-colors"
      />
    </div>
  )
}

// ─── image helpers ────────────────────────────────────────────────────────────

function extractBgUrl(bgImage: string): string {
  const m = bgImage.match(/url\(["']?([^"')]+)["']?\)/)
  return m ? m[1] : ''
}

function buildBgUrl(url: string): string {
  const u = url.trim()
  return u ? `url("${u}")` : ''
}

function parsePosKeyword(s: string): number {
  if (s === 'left' || s === 'top') return 0
  if (s === 'right' || s === 'bottom') return 100
  if (s === 'center') return 50
  const n = parseFloat(s)
  return isNaN(n) ? 50 : Math.round(n)
}

function parsePosition(pos: string): [number, number] {
  if (!pos || pos === 'initial' || pos === 'normal' || pos === 'none') return [50, 50]
  const parts = pos.trim().split(/\s+/)
  if (parts.length >= 2) return [parsePosKeyword(parts[0]), parsePosKeyword(parts[1])]
  const p = parsePosKeyword(parts[0])
  return [p, 50]
}

// Derive fit + zoom from background-size computed value.
// Chrome normalises "150%" → "150% auto", so we match the first percentage.
function parseBgSize(bgSize: string): [string, number] {
  if (!bgSize || bgSize === 'auto' || bgSize === 'auto auto') return ['none', 100]
  if (bgSize === 'cover') return ['cover', 100]
  if (bgSize === 'contain') return ['contain', 100]
  if (bgSize === '100% 100%') return ['fill', 100]
  const m = bgSize.match(/^([\d.]+)%/)
  if (m) return ['cover', Math.round(parseFloat(m[1]))]
  return ['cover', 100]
}

// Chrome may return scale(1.5) or matrix(1.5, 0, 0, 1.5, 0, 0).
function parseTransformScale(transform: string): number {
  if (!transform || transform === 'none') return 100
  const s = transform.match(/^scale\(([\d.]+)\)/)
  if (s) return Math.round(parseFloat(s[1]) * 100)
  const m = transform.match(/^matrix\(([\d.]+)/)
  if (m) return Math.round(parseFloat(m[1]) * 100)
  return 100
}

function computeBgSize(fit: string, zoom: number): string {
  if (fit === 'contain') return 'contain'
  if (fit === 'fill') return '100% 100%'
  if (fit === 'none' && zoom === 100) return 'auto'
  if (fit === 'cover' && zoom === 100) return 'cover'
  return `${zoom}%`
}

const FIT_OPTIONS = ['cover', 'contain', 'fill', 'none'] as const

const GRID_ANCHORS = [
  { x: 0,   y: 0,   label: 'Top Left' },
  { x: 50,  y: 0,   label: 'Top Center' },
  { x: 100, y: 0,   label: 'Top Right' },
  { x: 0,   y: 50,  label: 'Center Left' },
  { x: 50,  y: 50,  label: 'Center' },
  { x: 100, y: 50,  label: 'Center Right' },
  { x: 0,   y: 100, label: 'Bottom Left' },
  { x: 50,  y: 100, label: 'Bottom Center' },
  { x: 100, y: 100, label: 'Bottom Right' },
]

// ─── focal point picker ───────────────────────────────────────────────────────

function FocalPointPicker({
  imgUrl, focalX, focalY, onChange,
}: {
  imgUrl: string
  focalX: number
  focalY: number
  onChange: (x: number, y: number) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)

  function startDrag(e: React.MouseEvent<HTMLDivElement>) {
    e.preventDefault()
    const rect = containerRef.current!.getBoundingClientRect()

    function clamped(cx: number, cy: number): [number, number] {
      return [
        Math.round(Math.max(0, Math.min(100, ((cx - rect.left) / rect.width) * 100))),
        Math.round(Math.max(0, Math.min(100, ((cy - rect.top)  / rect.height) * 100))),
      ]
    }

    onChange(...clamped(e.clientX, e.clientY))

    function onMove(me: MouseEvent) { onChange(...clamped(me.clientX, me.clientY)) }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      ref={containerRef}
      className="relative w-full overflow-hidden rounded border border-gray-700 cursor-crosshair select-none"
      style={{ height: 72 }}
      onMouseDown={startDrag}
    >
      {/* Checkerboard background when no image */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: 'repeating-conic-gradient(#374151 0% 25%, #1f2937 0% 50%)',
          backgroundSize: '12px 12px',
        }}
      />
      {imgUrl && (
        <img
          src={imgUrl}
          alt=""
          draggable={false}
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ objectFit: 'cover', objectPosition: `${focalX}% ${focalY}%` }}
        />
      )}
      {/* Crosshair lines */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-0 bottom-0 w-px bg-white/30" style={{ left: `${focalX}%` }} />
        <div className="absolute left-0 right-0 h-px bg-white/30" style={{ top: `${focalY}%` }} />
        <div
          className="absolute w-3 h-3 rounded-full border-2 border-white -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${focalX}%`, top: `${focalY}%`, background: 'rgba(59,130,246,0.9)', boxShadow: '0 0 0 1px rgba(0,0,0,0.4)' }}
        />
      </div>
      <span className="absolute bottom-0.5 right-1 text-[9px] text-white/40 font-mono pointer-events-none">
        {focalX}% {focalY}%
      </span>
    </div>
  )
}

// ─── image section ────────────────────────────────────────────────────────────

interface ImageSectionProps {
  element: SelectedElement
  saveStatus: SaveStatus
  onSave: (patch: InspectorSavePatch) => void
  onPickFile: () => Promise<ImagePickResult | null>
  onLivePatch: (patch: DomPatch) => void
}

function ImageSection({ element, saveStatus, onSave, onPickFile, onLivePatch }: ImageSectionProps) {
  const isImg = element.tagName === 'img'
  const hasBg = element.computed.backgroundImage !== 'none' && element.computed.backgroundImage !== ''

  // ── Stable "original" values derived from the element prop ─────────────────
  const origSrc    = element.imageSrc    ?? ''
  const origAlt    = element.imageAlt    ?? ''
  const origWidth  = element.imageWidth  ?? ''
  const origHeight = element.imageHeight ?? ''
  const origBgUrl  = extractBgUrl(element.computed.backgroundImage ?? '')

  // Derive fit / zoom / focal from computed styles
  const [initFit, initZoom] = isImg
    ? [element.computed.objectFit || 'cover', parseTransformScale(element.computed.transform ?? '')]
    : parseBgSize(element.computed.backgroundSize ?? '')
  const [initFX, initFY] = isImg
    ? parsePosition(element.computed.objectPosition ?? '50% 50%')
    : parsePosition(element.computed.backgroundPosition ?? '50% 50%')

  const [draftSrc,    setDraftSrc]    = useState(origSrc)
  const [draftAlt,    setDraftAlt]    = useState(origAlt)
  const [draftWidth,  setDraftWidth]  = useState(origWidth)
  const [draftHeight, setDraftHeight] = useState(origHeight)
  const [draftBgUrl,  setDraftBgUrl]  = useState(origBgUrl)
  const [draftFit,    setDraftFit]    = useState(initFit)
  const [draftZoom,   setDraftZoom]   = useState(initZoom)
  const [draftFX,     setDraftFX]     = useState(initFX)
  const [draftFY,     setDraftFY]     = useState(initFY)
  const [picking,     setPicking]     = useState(false)

  useEffect(() => {
    setDraftSrc(element.imageSrc ?? '')
    setDraftAlt(element.imageAlt ?? '')
    setDraftWidth(element.imageWidth ?? '')
    setDraftHeight(element.imageHeight ?? '')
    setDraftBgUrl(extractBgUrl(element.computed.backgroundImage ?? ''))
    if (isImg) {
      setDraftFit(element.computed.objectFit || 'cover')
      setDraftZoom(parseTransformScale(element.computed.transform ?? ''))
      const [fx, fy] = parsePosition(element.computed.objectPosition ?? '50% 50%')
      setDraftFX(fx); setDraftFY(fy)
    } else {
      const [fit, zoom] = parseBgSize(element.computed.backgroundSize ?? '')
      setDraftFit(fit); setDraftZoom(zoom)
      const [fx, fy] = parsePosition(element.computed.backgroundPosition ?? '50% 50%')
      setDraftFX(fx); setDraftFY(fy)
    }
  }, [element])

  // ── Live DOM patch builder ─────────────────────────────────────────────────
  function livePatch(fit: string, zoom: number, fx: number, fy: number): DomPatch {
    const pos = `${fx}% ${fy}%`
    if (isImg) {
      return {
        objectFit: fit,
        objectPosition: pos,
        transform: zoom !== 100 ? `scale(${zoom / 100})` : 'none',
      }
    }
    return {
      backgroundSize: computeBgSize(fit, zoom),
      backgroundPosition: pos,
    }
  }

  function patchFit(fit: string) {
    setDraftFit(fit)
    onLivePatch(livePatch(fit, draftZoom, draftFX, draftFY))
  }
  function patchZoom(zoom: number) {
    setDraftZoom(zoom)
    onLivePatch(livePatch(draftFit, zoom, draftFX, draftFY))
  }
  function patchFocal(fx: number, fy: number) {
    setDraftFX(fx); setDraftFY(fy)
    onLivePatch(livePatch(draftFit, draftZoom, fx, fy))
  }

  // ── Change detection ───────────────────────────────────────────────────────
  const srcChanged    = draftSrc.trim()    !== origSrc.trim()
  const altChanged    = draftAlt.trim()    !== origAlt.trim()
  const widthChanged  = draftWidth.trim()  !== origWidth.trim()
  const heightChanged = draftHeight.trim() !== origHeight.trim()
  const bgUrlChanged  = draftBgUrl.trim()  !== origBgUrl.trim()
  const fitChanged    = draftFit           !== initFit
  const zoomChanged   = draftZoom          !== initZoom
  const focalChanged  = draftFX !== initFX || draftFY !== initFY
  const hasChanges    = srcChanged || altChanged || widthChanged || heightChanged
    || bgUrlChanged || fitChanged || zoomChanged || focalChanged

  // ── Actions ────────────────────────────────────────────────────────────────
  async function handlePickFile() {
    setPicking(true)
    try {
      const result = await onPickFile()
      if (result) {
        if (isImg) setDraftSrc(result.url)
        else setDraftBgUrl(result.url)
      }
    } finally {
      setPicking(false)
    }
  }

  function handleSave() {
    const pos = `${draftFX}% ${draftFY}%`
    const patch: InspectorSavePatch = { element }

    if (isImg) {
      if (srcChanged)    patch.imageSrc     = draftSrc.trim()
      if (altChanged)    patch.imageAlt     = draftAlt.trim()
      if (widthChanged)  patch.imageWidth   = draftWidth.trim()
      if (heightChanged) patch.imageHeight  = draftHeight.trim()
      // Always write the complete display-style set atomically so the source
      // reflects exactly what's shown (writeInlineStyle will merge these).
      patch.objectFit      = draftFit
      patch.objectPosition = pos
      patch.transform      = draftZoom !== 100 ? `scale(${draftZoom / 100})` : 'none'
    } else {
      if (bgUrlChanged) patch.backgroundImage = buildBgUrl(draftBgUrl)
      // Always write the complete set so backgroundSize + backgroundPosition
      // stay consistent in the source file.
      patch.backgroundSize     = computeBgSize(draftFit, draftZoom)
      patch.backgroundPosition = pos
    }

    onSave(patch)
  }

  function handleReset() {
    setDraftFit('cover'); setDraftZoom(100); setDraftFX(50); setDraftFY(50)
    onLivePatch(livePatch('cover', 100, 50, 50))
  }

  function handleCancel() {
    setDraftSrc(origSrc); setDraftAlt(origAlt)
    setDraftWidth(origWidth); setDraftHeight(origHeight)
    setDraftBgUrl(origBgUrl)
    setDraftFit(initFit); setDraftZoom(initZoom)
    setDraftFX(initFX); setDraftFY(initFY)
    onLivePatch(livePatch(initFit, initZoom, initFX, initFY))
  }

  // SVG / picture: not editable
  if (!isImg && !hasBg) {
    return (
      <Section title="Image">
        <p className="text-gray-700 text-[11px]">
          {element.tagName === 'svg' ? 'Inline SVG — edit in source.' : 'Complex image element — edit in source.'}
        </p>
      </Section>
    )
  }

  const thumbUrl = isImg ? draftSrc : draftBgUrl

  return (
    <div className="px-3 py-2 border-b border-gray-800/60">
      <div className="flex items-center gap-1.5 mb-2">
        <ImageIcon className="w-3 h-3 text-green-400" />
        <p className="text-[10px] text-gray-700 uppercase tracking-widest font-medium">Image</p>
      </div>

      {/* Focal point — interactive thumbnail */}
      <div className="mb-2">
        <p className="text-[10px] text-gray-600 mb-1">Focal Point</p>
        <FocalPointPicker imgUrl={thumbUrl} focalX={draftFX} focalY={draftFY} onChange={patchFocal} />
      </div>

      {/* Src / URL with file picker */}
      <div className="mb-2">
        <p className="text-[10px] text-gray-600 mb-1">{isImg ? 'Src' : 'Background URL'}</p>
        <div className="flex gap-1">
          <input
            type="text"
            value={isImg ? draftSrc : draftBgUrl}
            placeholder={isImg ? '/images/photo.jpg' : 'https://…'}
            onChange={(e) => isImg ? setDraftSrc(e.target.value) : setDraftBgUrl(e.target.value)}
            className="flex-1 min-w-0 bg-gray-800 border border-gray-700 focus:border-blue-500 focus:outline-none rounded px-2 py-1.5 text-[11px] text-gray-200 font-mono transition-colors"
          />
          <button
            onClick={handlePickFile}
            disabled={picking}
            title="Choose image file"
            className="px-2 py-1.5 bg-gray-800 border border-gray-700 hover:border-gray-600 hover:bg-gray-700 rounded text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-40"
          >
            <FolderOpen className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Alt — img only */}
      {isImg && (
        <EditField label="Alt text" value={draftAlt} placeholder="Describe the image…" onChange={setDraftAlt} />
      )}

      {/* Width / height — img only */}
      {isImg && (
        <div className="flex gap-2 mb-2">
          <div className="flex-1">
            <p className="text-[10px] text-gray-600 mb-1">Width</p>
            <input type="text" value={draftWidth} placeholder="auto"
              onChange={(e) => setDraftWidth(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 focus:border-blue-500 focus:outline-none rounded px-2 py-1.5 text-[11px] text-gray-200 font-mono transition-colors" />
          </div>
          <div className="flex-1">
            <p className="text-[10px] text-gray-600 mb-1">Height</p>
            <input type="text" value={draftHeight} placeholder="auto"
              onChange={(e) => setDraftHeight(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 focus:border-blue-500 focus:outline-none rounded px-2 py-1.5 text-[11px] text-gray-200 font-mono transition-colors" />
          </div>
        </div>
      )}

      {/* Object Fit — 4 toggle buttons */}
      <div className="mb-2">
        <p className="text-[10px] text-gray-600 mb-1">Object Fit</p>
        <div className="grid grid-cols-4 gap-1">
          {FIT_OPTIONS.map((opt) => (
            <button
              key={opt}
              onClick={() => patchFit(opt)}
              className={`py-1 text-[10px] rounded border capitalize transition-colors ${
                draftFit === opt
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600 hover:text-gray-200'
              }`}
            >
              {opt}
            </button>
          ))}
        </div>
      </div>

      {/* Position — 3×3 grid */}
      <div className="mb-2">
        <p className="text-[10px] text-gray-600 mb-1">Position</p>
        <div className="inline-grid grid-cols-3 gap-0.5">
          {GRID_ANCHORS.map(({ x, y, label }) => {
            const active = draftFX === x && draftFY === y
            return (
              <button
                key={label}
                title={label}
                onClick={() => patchFocal(x, y)}
                className={`w-[22px] h-[22px] flex items-center justify-center rounded border transition-colors ${
                  active
                    ? 'bg-blue-600 border-blue-500'
                    : 'bg-gray-800 border-gray-700 hover:bg-gray-700'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-white' : 'bg-gray-500'}`} />
              </button>
            )
          })}
        </div>
      </div>

      {/* Zoom slider */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1">
          <p className="text-[10px] text-gray-600">Zoom</p>
          <span className="text-[10px] text-gray-400 font-mono">{draftZoom}%</span>
        </div>
        <input
          type="range"
          min={25}
          max={300}
          value={draftZoom}
          onChange={(e) => patchZoom(parseInt(e.target.value, 10))}
          className="w-full accent-blue-500 cursor-pointer"
        />
        <div className="flex justify-between text-[9px] text-gray-700 mt-0.5">
          <span>25%</span><span>300%</span>
        </div>
      </div>

      {/* Reset / Save / Cancel */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={handleReset}
          title="Reset to Cover / Center / 100%"
          className="px-2 py-1.5 text-gray-500 hover:text-gray-300 text-xs rounded border border-gray-800 hover:border-gray-700 transition-colors"
        >
          Reset
        </button>
        <button
          onClick={handleSave}
          disabled={!hasChanges || saveStatus === 'saving'}
          className="flex-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed text-white text-xs rounded transition-colors"
        >
          Save
        </button>
        <button
          onClick={handleCancel}
          disabled={!hasChanges}
          className="px-2 py-1.5 text-gray-500 hover:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed text-xs rounded border border-gray-800 hover:border-gray-700 transition-colors"
        >
          Cancel
        </button>
      </div>

      {saveStatus !== 'idle' && (
        <div className="mt-2 flex justify-center">
          <SaveStatusBadge status={saveStatus} />
        </div>
      )}
    </div>
  )
}

// ─── link / button editable section ──────────────────────────────────────────

function KindIcon({ kind }: { kind: ElementKind }) {
  if (kind === 'link')   return <Link2 className="w-3 h-3 text-blue-400" />
  if (kind === 'button') return <MousePointerClick className="w-3 h-3 text-purple-400" />
  if (kind === 'image')  return <ImageIcon className="w-3 h-3 text-green-400" />
  return null
}

interface EditableSectionProps {
  element: SelectedElement
  saveStatus: SaveStatus
  onSave: (patch: InspectorSavePatch) => void
}

function LinkButtonSection({ element, saveStatus, onSave }: EditableSectionProps) {
  const kind      = classifyElement(element)
  const showHref  = element.tagName === 'a'
  const showValue = element.tagName === 'input' && Boolean(element.inputType)

  const originalText     = element.textContent ?? ''
  const originalHref     = element.href ?? ''
  const originalDisabled = element.disabled ?? false
  const originalValue    = element.value ?? ''

  const [draftText,     setDraftText]     = useState(originalText)
  const [draftHref,     setDraftHref]     = useState(originalHref)
  const [draftDisabled, setDraftDisabled] = useState(originalDisabled)
  const [draftValue,    setDraftValue]    = useState(originalValue)

  useEffect(() => {
    setDraftText(element.textContent ?? '')
    setDraftHref(element.href ?? '')
    setDraftDisabled(element.disabled ?? false)
    setDraftValue(element.value ?? '')
  }, [element])

  const textChanged     = draftText.trim()  !== originalText.trim()
  const hrefChanged     = draftHref.trim()  !== originalHref.trim()
  const disabledChanged = draftDisabled     !== originalDisabled
  const valueChanged    = draftValue.trim() !== originalValue.trim()
  const hasChanges      = textChanged || hrefChanged || disabledChanged || valueChanged

  function handleSave() {
    const patch: InspectorSavePatch = { element }
    if (textChanged)     patch.text     = draftText.trim()
    if (hrefChanged)     patch.href     = draftHref.trim()
    if (disabledChanged) patch.disabled = draftDisabled
    if (valueChanged)    patch.text     = draftValue.trim()
    onSave(patch)
  }

  function handleCancel() {
    setDraftText(originalText)
    setDraftHref(originalHref)
    setDraftDisabled(originalDisabled)
    setDraftValue(originalValue)
  }

  return (
    <div className="px-3 py-2 border-b border-gray-800/60">
      <div className="flex items-center gap-1.5 mb-2">
        <KindIcon kind={kind} />
        <p className="text-[10px] text-gray-700 uppercase tracking-widest font-medium">Editable</p>
      </div>

      {!showValue ? (
        <EditField label="Text" value={draftText} placeholder="Element text…" onChange={setDraftText} />
      ) : (
        <EditField label="Value" value={draftValue} placeholder="Button value…" onChange={setDraftValue} />
      )}

      {showHref && (
        <EditField label="Href" value={draftHref} placeholder="https://…" onChange={setDraftHref} />
      )}

      {(element.tagName === 'button' || element.tagName === 'input') && (
        <label className="flex items-center gap-2 mb-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={draftDisabled}
            onChange={(e) => setDraftDisabled(e.target.checked)}
            className="accent-blue-500"
          />
          <span className="text-[11px] text-gray-400">Disabled</span>
        </label>
      )}

      <div className="flex items-center gap-2 mt-1">
        <button
          onClick={handleSave}
          disabled={!hasChanges || saveStatus === 'saving'}
          className="flex-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed text-white text-xs rounded transition-colors"
        >
          Save
        </button>
        <button
          onClick={handleCancel}
          disabled={!hasChanges}
          className="px-3 py-1.5 text-gray-500 hover:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed text-xs rounded border border-gray-800 hover:border-gray-700 transition-colors"
        >
          Cancel
        </button>
      </div>

      {saveStatus !== 'idle' && (
        <div className="mt-2 flex justify-center">
          <SaveStatusBadge status={saveStatus} />
        </div>
      )}
    </div>
  )
}

// ─── source metadata debug panel ─────────────────────────────────────────────

function SourceMetaSection({ element }: { element: SelectedElement }) {
  const { hbSourceFile, hbSourceLine, hbSourceCol, hbComponentName } = element
  const hasSource = Boolean(hbSourceFile)
  const fileName  = hbSourceFile?.split('/').pop() ?? hbSourceFile

  if (!hasSource) {
    return (
      <div className="mx-2 mt-2 mb-1 rounded border border-red-700 bg-red-950/50 p-2.5">
        <div className="flex items-center gap-1.5 mb-1.5">
          <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
          <span className="text-red-300 text-[11px] font-bold uppercase tracking-wide">
            NO SOURCE METADATA
          </span>
        </div>
        <p className="text-red-400/80 text-[10px] leading-relaxed">
          FILE SAVING WILL NOT WORK.<br />
          Vite plugin not active or React fiber missing <span className="font-mono">_debugSource</span>.
        </p>
        <p className="text-red-600/60 text-[10px] mt-1 font-mono">
          tag: &lt;{element.tagName}&gt;
        </p>
      </div>
    )
  }

  return (
    <div className="mx-2 mt-2 mb-1 rounded border border-green-800 bg-green-950/40 p-2.5">
      <div className="flex items-center gap-1.5 mb-1.5">
        <MapPin className="w-3.5 h-3.5 text-green-400 shrink-0" />
        <span className="text-green-300 text-[11px] font-bold uppercase tracking-wide">
          Source Located
        </span>
      </div>
      <div className="space-y-1 font-mono text-[10px]">
        <div className="flex justify-between gap-2">
          <span className="text-gray-600 shrink-0">file</span>
          <span className="text-green-400 break-all text-right" title={hbSourceFile ?? ''}>{fileName}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-gray-600 shrink-0">line</span>
          <span className="text-green-300">{hbSourceLine ?? '?'}</span>
        </div>
        {hbSourceCol != null && (
          <div className="flex justify-between gap-2">
            <span className="text-gray-600 shrink-0">col</span>
            <span className="text-green-300">{hbSourceCol}</span>
          </div>
        )}
        {hbComponentName && (
          <div className="flex justify-between gap-2">
            <span className="text-gray-600 shrink-0">owner</span>
            <span className="text-purple-300">{hbComponentName}</span>
          </div>
        )}
        <div className="flex justify-between gap-2 pt-0.5 border-t border-green-900/60">
          <span className="text-gray-600 shrink-0">tag</span>
          <span className="text-blue-400">&lt;{element.tagName}&gt;</span>
        </div>
      </div>
    </div>
  )
}

// ─── dev server log panel (shown in empty state) ──────────────────────────────

function HbLogPanel({ hbLogs }: { hbLogs: string[] }) {
  const hasPlugin = hbLogs.some((l) => l.includes('[hb-plugin]'))
  const hasConfig = hbLogs.some((l) => l.includes('[hb-config]'))
  const hasCmd    = hbLogs.some((l) => l.includes('[handybuilder]'))
  const any       = hasPlugin || hasConfig || hasCmd

  return (
    <div className="mx-2 mt-3 rounded border border-gray-800 bg-gray-900/60 p-2">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${any ? 'bg-green-500' : 'bg-red-600'}`} />
        <span className="text-[10px] text-gray-600 uppercase tracking-widest font-medium">HB Dev Server</span>
      </div>

      <div className="space-y-1 text-[10px] mb-2">
        <div className="flex items-center gap-1.5">
          <span className={hasCmd    ? 'text-green-500' : 'text-red-600'}>●</span>
          <span className="text-gray-600">HB command logged</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={hasConfig ? 'text-green-500' : 'text-red-600'}>●</span>
          <span className="text-gray-600">wrapper config loaded</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={hasPlugin ? 'text-green-500' : 'text-red-600'}>●</span>
          <span className="text-gray-600">source plugin active</span>
        </div>
      </div>

      {hbLogs.length === 0 ? (
        <p className="text-gray-700 text-[10px] italic">No HB log lines yet — open a project to start the dev server.</p>
      ) : (
        <div className="space-y-px max-h-40 overflow-y-auto">
          {hbLogs.map((line, i) => (
            <p key={i} className="font-mono text-[9px] text-gray-500 leading-relaxed break-all whitespace-pre-wrap">{line}</p>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── main panel ───────────────────────────────────────────────────────────────

interface InspectorPanelProps {
  selectedElement: SelectedElement | null
  saveStatus: SaveStatus
  hbLogs: string[]
  onClearSelection: () => void
  onInspectorSave: (patch: InspectorSavePatch) => void
  onPickFile: () => Promise<ImagePickResult | null>
  onLivePatch: (patch: DomPatch) => void
}

export function InspectorPanel({
  selectedElement,
  saveStatus,
  hbLogs,
  onClearSelection,
  onInspectorSave,
  onPickFile,
  onLivePatch,
}: InspectorPanelProps) {
  return (
    <div className="w-60 flex flex-col bg-gray-900 border-l border-gray-800 shrink-0 overflow-hidden">
      <div className="h-9 flex items-center justify-between px-3 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="w-3.5 h-3.5 text-gray-600" />
          <span className="text-gray-500 text-[11px] font-medium uppercase tracking-widest">Inspector</span>
        </div>
        {selectedElement && (
          <button onClick={onClearSelection} title="Clear selection" className="text-gray-700 hover:text-gray-300 transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {!selectedElement ? (
        <div className="flex-1 overflow-y-auto pb-4">
          <div className="flex flex-col items-center gap-3 p-6 pb-3">
            <SlidersHorizontal className="w-7 h-7 text-gray-800" />
            <p className="text-gray-700 text-xs text-center leading-relaxed">
              No element selected.<br />
              Enable <span className="text-gray-600">Inspect</span> mode<br />
              and click any element.
            </p>
          </div>
          <HbLogPanel hbLogs={hbLogs} />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {/* Source metadata — MUST be first so it's always visible */}
          <SourceMetaSection element={selectedElement} />

          {/* Identity */}
          <Section title="Element">
            <div className="flex flex-wrap items-baseline gap-1">
              <span className="font-mono text-blue-400 text-sm">&lt;{selectedElement.tagName}&gt;</span>
              {selectedElement.id && (
                <span className="font-mono text-yellow-400 text-[11px]">#{selectedElement.id}</span>
              )}
            </div>
            {selectedElement.classList.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {selectedElement.classList.map((c) => (
                  <span key={c} className="font-mono text-[10px] text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded">.{c}</span>
                ))}
              </div>
            )}
          </Section>

          {/* Editable section — image, link, or button */}
          {isEditable(selectedElement) && (() => {
            const kind = classifyElement(selectedElement)
            if (kind === 'image') {
              return (
                <ImageSection
                  element={selectedElement}
                  saveStatus={saveStatus}
                  onSave={onInspectorSave}
                  onPickFile={onPickFile}
                  onLivePatch={onLivePatch}
                />
              )
            }
            return (
              <LinkButtonSection
                element={selectedElement}
                saveStatus={saveStatus}
                onSave={onInspectorSave}
              />
            )
          })()}

          {/* Box model */}
          <Section title="Box Model">
            <Prop label="Size">
              <span className="text-gray-300">{selectedElement.rect.width}&thinsp;×&thinsp;{selectedElement.rect.height} px</span>
            </Prop>
            <Prop label="Margin">
              <span className="text-gray-300 font-mono">
                {shorthand(selectedElement.computed.marginTop, selectedElement.computed.marginRight, selectedElement.computed.marginBottom, selectedElement.computed.marginLeft)}
              </span>
            </Prop>
            <Prop label="Padding">
              <span className="text-gray-300 font-mono">
                {shorthand(selectedElement.computed.paddingTop, selectedElement.computed.paddingRight, selectedElement.computed.paddingBottom, selectedElement.computed.paddingLeft)}
              </span>
            </Prop>
          </Section>

          {/* Typography */}
          <Section title="Typography">
            <Prop label="Font size"><span className="text-gray-300 font-mono">{selectedElement.computed.fontSize}</span></Prop>
            <Prop label="Color"><ColorSwatch color={selectedElement.computed.color} /></Prop>
          </Section>

          {/* Background */}
          <Section title="Background">
            <Prop label="Color"><ColorSwatch color={selectedElement.computed.backgroundColor} /></Prop>
          </Section>

          {selectedElement.textContent && (
            <Section title="Content">
              <p className="text-gray-500 text-[11px] font-mono leading-relaxed break-words line-clamp-5">
                &ldquo;{selectedElement.textContent}&rdquo;
              </p>
            </Section>
          )}
        </div>
      )}
    </div>
  )
}
