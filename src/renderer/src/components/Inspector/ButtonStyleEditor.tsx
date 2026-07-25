import { RotateCcw } from 'lucide-react'
import { SelectedElement, SaveStatus, InspectorSavePatch, DomPatch, StyleProps } from '../../types'
import { useElementStyleDraft } from '../../hooks/useElementStyleDraft'
import { LinkButtonSection } from './ContentSection'
import { SourceLocatedBadge, AdvancedElementInfo } from './AdvancedElementInfo'
import { StateSwitcher } from './StateSwitcher'
import { StyleAccordion } from './StyleAccordion'
import { ColourControl } from './ColourControl'
import { TypographyControls } from './TypographyControls'
import { BorderControl } from './BorderControl'
import { LinkedSpacingControl } from './LinkedSpacingControl'
import { NumberUnitControl } from './NumberUnitControl'
import { ShadowControl } from './ShadowControl'
import { SaveStatusBadge } from '../Editor/SaveStatusBadge'

const TYPOGRAPHY_KEYS: (keyof StyleProps)[] = [
  'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign', 'textTransform', 'textDecoration',
]
const COLOUR_KEYS: (keyof StyleProps)[] = ['color', 'backgroundColor', 'borderColor']
const BORDER_KEYS: (keyof StyleProps)[] = [
  'borderWidth', 'borderStyle', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius',
]
const SPACING_KEYS: (keyof StyleProps)[] = [
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
]
const SIZE_KEYS: (keyof StyleProps)[] = ['width', 'minWidth', 'height', 'display', 'justifyContent', 'alignItems', 'gap', 'flexDirection']
const EFFECTS_KEYS: (keyof StyleProps)[] = ['boxShadow', 'opacity', 'transform', 'transitionDuration']

function parseTransform(t: string | undefined): { scale: string; translateY: string } {
  const v = t ?? ''
  const scaleM = /scale\(([\d.]+)\)/.exec(v)
  const transM = /translateY\((-?[\d.]+)px\)/.exec(v)
  return { scale: scaleM ? scaleM[1] : '1', translateY: transM ? transM[1] : '0' }
}
function buildTransform(scale: string, translateY: string): string {
  const parts: string[] = []
  if (scale && scale !== '1') parts.push(`scale(${scale})`)
  if (translateY && translateY !== '0') parts.push(`translateY(${translateY}px)`)
  return parts.join(' ')
}

interface ButtonStyleEditorProps {
  element: SelectedElement
  saveStatus: SaveStatus
  onSave: (patch: InspectorSavePatch) => void
  onLivePatch: (patch: DomPatch) => void
  onOpenFile: (filePath: string) => void
}

export function ButtonStyleEditor({ element, saveStatus, onSave, onLivePatch, onOpenFile }: ButtonStyleEditorProps) {
  const {
    state, setState, normal, hover, dirty,
    setNormalProp, setHoverProp, resetProp, resetSection, resetAll, cancel, buildSavePatch,
  } = useElementStyleDraft(element, onLivePatch)

  const isHover = state === 'hover'
  const activeValues: StyleProps = isHover ? { ...normal, ...hover } : normal
  const setProp = isHover ? setHoverProp : setNormalProp

  const transform = parseTransform(activeValues.transform)

  function handleSaveStyle() {
    const stylePatch = buildSavePatch()
    if (!stylePatch) return
    const hasHover = Object.keys(stylePatch.styleHover).length > 0
    onSave({
      element,
      styleNormal: stylePatch.styleNormal,
      styleHover: stylePatch.styleHover,
      styleDescription: hasHover ? 'Changed button style (+ hover)' : 'Changed button style',
    })
  }

  return (
    <div>
      <SourceLocatedBadge element={element} />

      <StyleAccordion title="Content" defaultOpen>
        <LinkButtonSection element={element} saveStatus={saveStatus} onSave={onSave} />
      </StyleAccordion>

      <StateSwitcher state={state} onChange={setState} />

      {!isHover && (
        <StyleAccordion title="Typography" onResetSection={() => resetSection(TYPOGRAPHY_KEYS)}>
          <TypographyControls values={activeValues} onChange={setProp} />
        </StyleAccordion>
      )}

      <StyleAccordion title="Colours" onResetSection={() => resetSection(COLOUR_KEYS)}>
        <div className="space-y-1.5">
          <ColourControl label="Text" value={activeValues.color ?? ''} onChange={(v) => setProp('color', v)} onReset={() => resetProp('color')} />
          <ColourControl label="Background" value={activeValues.backgroundColor ?? ''} onChange={(v) => setProp('backgroundColor', v)} onReset={() => resetProp('backgroundColor')} />
          <ColourControl label="Border" value={activeValues.borderColor ?? ''} onChange={(v) => setProp('borderColor', v)} onReset={() => resetProp('borderColor')} />
        </div>
      </StyleAccordion>

      {!isHover && (
        <StyleAccordion title="Border" onResetSection={() => resetSection(BORDER_KEYS)}>
          <BorderControl
            width={activeValues.borderWidth ?? ''}
            style={activeValues.borderStyle ?? 'solid'}
            radiusTL={activeValues.borderTopLeftRadius ?? ''}
            radiusTR={activeValues.borderTopRightRadius ?? ''}
            radiusBR={activeValues.borderBottomRightRadius ?? ''}
            radiusBL={activeValues.borderBottomLeftRadius ?? ''}
            onWidthChange={(v) => setProp('borderWidth', v)}
            onStyleChange={(v) => setProp('borderStyle', v)}
            onRadiusChange={(corner, v) => {
              const key = ({
                TL: 'borderTopLeftRadius', TR: 'borderTopRightRadius',
                BR: 'borderBottomRightRadius', BL: 'borderBottomLeftRadius',
              } as const)[corner]
              setProp(key, v)
            }}
            onResetWidth={() => resetSection(['borderWidth', 'borderStyle'])}
            onResetRadius={() => resetSection(['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'])}
          />
        </StyleAccordion>
      )}

      {!isHover && (
        <StyleAccordion title="Spacing" onResetSection={() => resetSection(SPACING_KEYS)}>
          <div className="space-y-2">
            <LinkedSpacingControl
              label="Padding"
              top={activeValues.paddingTop ?? ''} right={activeValues.paddingRight ?? ''}
              bottom={activeValues.paddingBottom ?? ''} left={activeValues.paddingLeft ?? ''}
              onChange={(side, v) => setProp(`padding${side}` as keyof StyleProps, v)}
              onReset={() => resetSection(['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'])}
            />
            <LinkedSpacingControl
              label="Margin"
              top={activeValues.marginTop ?? ''} right={activeValues.marginRight ?? ''}
              bottom={activeValues.marginBottom ?? ''} left={activeValues.marginLeft ?? ''}
              onChange={(side, v) => setProp(`margin${side}` as keyof StyleProps, v)}
              onReset={() => resetSection(['marginTop', 'marginRight', 'marginBottom', 'marginLeft'])}
            />
          </div>
        </StyleAccordion>
      )}

      {!isHover && (
        <StyleAccordion title="Size & Alignment" onResetSection={() => resetSection(SIZE_KEYS)}>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-600 w-16 shrink-0">Width</span>
              <div className="grid grid-cols-3 gap-0.5 flex-1">
                {(['auto', '100%'] as const).map((w) => (
                  <button key={w} onClick={() => setProp('width', w)}
                    className={`py-1 text-[9px] rounded border transition-colors ${activeValues.width === w ? 'bg-blue-600 border-blue-500 text-white' : 'bg-gray-800 border-gray-700 text-gray-400'}`}>
                    {w === 'auto' ? 'Auto' : 'Full'}
                  </button>
                ))}
                <input type="text" placeholder="240px" value={activeValues.width && activeValues.width !== 'auto' && activeValues.width !== '100%' ? activeValues.width : ''}
                  onChange={(e) => setProp('width', e.target.value)}
                  className="bg-gray-800 border border-gray-700 rounded px-1 py-1 text-[9px] text-gray-200 font-mono min-w-0" />
              </div>
            </div>
            <NumberUnitControl label="Min width" value={activeValues.minWidth ?? ''} onChange={(v) => setProp('minWidth', v)} />
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-600 w-16 shrink-0">Height</span>
              <div className="grid grid-cols-2 gap-0.5 flex-1">
                <button onClick={() => setProp('height', 'auto')}
                  className={`py-1 text-[9px] rounded border transition-colors ${activeValues.height === 'auto' ? 'bg-blue-600 border-blue-500 text-white' : 'bg-gray-800 border-gray-700 text-gray-400'}`}>Auto</button>
                <input type="text" placeholder="48px" value={activeValues.height && activeValues.height !== 'auto' ? activeValues.height : ''}
                  onChange={(e) => setProp('height', e.target.value)}
                  className="bg-gray-800 border border-gray-700 rounded px-1 py-1 text-[9px] text-gray-200 font-mono min-w-0" />
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-600 w-16 shrink-0">Display</span>
              <select value={activeValues.display ?? 'inline-flex'} onChange={(e) => setProp('display', e.target.value)}
                className="flex-1 bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[10px] text-gray-200">
                {['inline-flex', 'flex', 'block'].map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-600 w-16 shrink-0">Content</span>
              <div className="grid grid-cols-3 gap-0.5 flex-1">
                {['flex-start', 'center', 'flex-end'].map((j) => (
                  <button key={j} onClick={() => { setProp('justifyContent', j); setProp('alignItems', 'center') }}
                    className={`py-1 text-[9px] rounded border capitalize transition-colors ${activeValues.justifyContent === j ? 'bg-blue-600 border-blue-500 text-white' : 'bg-gray-800 border-gray-700 text-gray-400'}`}>
                    {j === 'flex-start' ? 'Left' : j === 'flex-end' ? 'Right' : 'Center'}
                  </button>
                ))}
              </div>
            </div>
            <NumberUnitControl label="Icon gap" value={activeValues.gap ?? ''} onChange={(v) => setProp('gap', v)} />
          </div>
        </StyleAccordion>
      )}

      <StyleAccordion title="Effects" onResetSection={() => resetSection(EFFECTS_KEYS)}>
        <div className="space-y-2">
          <div>
            <p className="text-[10px] text-gray-600 mb-1">Shadow</p>
            <ShadowControl value={activeValues.boxShadow ?? ''} onChange={(v) => setProp('boxShadow', v)} onReset={() => resetProp('boxShadow')} />
          </div>
          <NumberUnitControl label="Opacity" value={activeValues.opacity ?? ''} onChange={(v) => setProp('opacity', v)} units={['']} onReset={() => resetProp('opacity')} />
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-gray-600 w-16 shrink-0">Scale</span>
            <input type="number" step="0.01" value={transform.scale}
              onChange={(e) => setProp('transform', buildTransform(e.target.value, transform.translateY))}
              className="w-16 bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[10px] text-gray-200 font-mono" />
            <span className="text-[10px] text-gray-600 w-16 shrink-0 text-right">Translate Y</span>
            <input type="number" step="1" value={transform.translateY}
              onChange={(e) => setProp('transform', buildTransform(transform.scale, e.target.value))}
              className="w-16 bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[10px] text-gray-200 font-mono" />
            <button onClick={() => resetProp('transform')} title="Reset" className="text-gray-700 hover:text-gray-300 transition-colors">
              <RotateCcw className="w-3 h-3" />
            </button>
          </div>
          <NumberUnitControl label="Transition" value={activeValues.transitionDuration ?? ''} onChange={(v) => setProp('transitionDuration', v)} units={['s', 'ms']} onReset={() => resetProp('transitionDuration')} />
        </div>
      </StyleAccordion>

      <AdvancedElementInfo element={element} onOpenFile={onOpenFile} />

      <div className="p-3 flex items-center gap-1.5 border-t border-gray-800">
        <button
          onClick={resetAll}
          disabled={!dirty}
          title="Reset all styles for this element"
          className="px-2 py-1.5 text-gray-500 hover:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed text-[11px] rounded border border-gray-800 hover:border-gray-700 transition-colors"
        >
          Reset all
        </button>
        <button
          onClick={handleSaveStyle}
          disabled={!dirty || saveStatus === 'saving'}
          className="flex-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed text-white text-xs rounded transition-colors"
        >
          Save{dirty ? ' •' : ''}
        </button>
        <button
          onClick={cancel}
          disabled={!dirty}
          className="px-3 py-1.5 text-gray-500 hover:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed text-xs rounded border border-gray-800 hover:border-gray-700 transition-colors"
        >
          Cancel
        </button>
      </div>

      {saveStatus !== 'idle' && (
        <div className="pb-3 flex justify-center">
          <SaveStatusBadge status={saveStatus} />
        </div>
      )}
    </div>
  )
}
