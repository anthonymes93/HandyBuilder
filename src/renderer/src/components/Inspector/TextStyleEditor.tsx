import { SelectedElement, SaveStatus, InspectorSavePatch, DomPatch, StyleProps } from '../../types'
import { useElementStyleDraft } from '../../hooks/useElementStyleDraft'
import { LinkButtonSection } from './ContentSection'
import { SourceLocatedBadge, AdvancedElementInfo } from './AdvancedElementInfo'
import { StateSwitcher } from './StateSwitcher'
import { StyleAccordion } from './StyleAccordion'
import { ColourControl } from './ColourControl'
import { TypographyControls } from './TypographyControls'
import { LinkedSpacingControl } from './LinkedSpacingControl'
import { NumberUnitControl } from './NumberUnitControl'
import { SaveStatusBadge } from '../Editor/SaveStatusBadge'

const TYPOGRAPHY_KEYS: (keyof StyleProps)[] = [
  'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign', 'textTransform', 'textDecoration',
]
const SPACING_KEYS: (keyof StyleProps)[] = [
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
]
const SIZE_KEYS: (keyof StyleProps)[] = ['width', 'maxWidth', 'opacity']

interface TextStyleEditorProps {
  element: SelectedElement
  saveStatus: SaveStatus
  onSave: (patch: InspectorSavePatch) => void
  onLivePatch: (patch: DomPatch) => void
  onOpenFile: (filePath: string) => void
}

/**
 * Trimmed-down style editor for headings/paragraphs/spans/labels/list items —
 * no href, no button border/background-heavy controls; adds hover only when
 * the element already has (or gains) hover styling.
 */
export function TextStyleEditor({ element, saveStatus, onSave, onLivePatch, onOpenFile }: TextStyleEditorProps) {
  const {
    state, setState, normal, hover, dirty,
    setNormalProp, setHoverProp, resetProp, resetSection, resetAll, cancel, buildSavePatch,
  } = useElementStyleDraft(element, onLivePatch)

  const isHover = state === 'hover'
  const activeValues: StyleProps = isHover ? { ...normal, ...hover } : normal
  const setProp = isHover ? setHoverProp : setNormalProp

  function handleSaveStyle() {
    const stylePatch = buildSavePatch()
    if (!stylePatch) return
    const hasHover = Object.keys(stylePatch.styleHover).length > 0
    onSave({
      element,
      styleNormal: stylePatch.styleNormal,
      styleHover: stylePatch.styleHover,
      styleDescription: hasHover ? 'Changed text style (+ hover)' : 'Changed text style',
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

      <StyleAccordion title="Colour" onResetSection={() => resetSection(['color'])}>
        <ColourControl label="Text" value={activeValues.color ?? ''} onChange={(v) => setProp('color', v)} onReset={() => resetProp('color')} />
      </StyleAccordion>

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
        <StyleAccordion title="Size" onResetSection={() => resetSection(SIZE_KEYS)}>
          <div className="space-y-1.5">
            <NumberUnitControl label="Width" value={activeValues.width ?? ''} onChange={(v) => setProp('width', v)} allowAuto />
            <NumberUnitControl label="Max width" value={activeValues.maxWidth ?? ''} onChange={(v) => setProp('maxWidth', v)} allowAuto />
            <NumberUnitControl label="Opacity" value={activeValues.opacity ?? ''} onChange={(v) => setProp('opacity', v)} units={['']} />
          </div>
        </StyleAccordion>
      )}

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
