import type { ChangeEvent } from 'react'
import { useState, useEffect } from 'react'
import { Link2, MousePointerClick, ImageIcon } from 'lucide-react'
import { SelectedElement, InspectorSavePatch, SaveStatus } from '../../types'
import { classifyElement, ElementKind } from '../../utils/elementKind'
import { SaveStatusBadge } from '../Editor/SaveStatusBadge'

/** Shared compact labelled text field, reused by ImageSection and LinkButtonSection. */
export function EditField({
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

/**
 * Content editor for text/href/disabled/new-tab fields. Adapts by tag: a
 * plain text element shows just "Text"; a link/button also shows Href +
 * "Open in new tab"; button/input additionally show "Disabled". Used both
 * standalone (legacy path) and as the "Content" accordion inside
 * ButtonStyleEditor / TextStyleEditor.
 */
export function LinkButtonSection({ element, saveStatus, onSave }: EditableSectionProps) {
  const kind      = classifyElement(element)
  const showHref  = element.tagName === 'a' || Boolean(element.href)
  // Card-level <a> wrappers (hbItemId set) contain the full card as textContent —
  // that multi-field aggregate is not meaningful to edit as a single text field.
  const showText  = !showHref || !element.hbItemId
  const showValue = element.tagName === 'input' && Boolean(element.inputType)

  const originalText     = element.textContent ?? ''
  const originalHref     = element.href ?? ''
  const originalDisabled = element.disabled ?? false
  const originalValue    = element.value ?? ''
  const originalNewTab   = element.linkTarget === '_blank'

  const [draftText,     setDraftText]     = useState(originalText)
  const [draftHref,     setDraftHref]     = useState(originalHref)
  const [draftDisabled, setDraftDisabled] = useState(originalDisabled)
  const [draftValue,    setDraftValue]    = useState(originalValue)
  const [draftNewTab,   setDraftNewTab]   = useState(originalNewTab)

  useEffect(() => {
    setDraftText(element.textContent ?? '')
    setDraftHref(element.href ?? '')
    setDraftDisabled(element.disabled ?? false)
    setDraftValue(element.value ?? '')
    setDraftNewTab(element.linkTarget === '_blank')
  }, [element])

  const textChanged     = showText && draftText.trim()  !== originalText.trim()
  const hrefChanged     = draftHref.trim()  !== originalHref.trim()
  const disabledChanged = draftDisabled     !== originalDisabled
  const valueChanged    = draftValue.trim() !== originalValue.trim()
  const newTabChanged   = draftNewTab       !== originalNewTab
  const hasChanges      = textChanged || hrefChanged || disabledChanged || valueChanged || newTabChanged

  function handleSave() {
    const patch: InspectorSavePatch = { element }
    if (textChanged)     patch.text       = draftText.trim()
    if (hrefChanged)     patch.href       = draftHref.trim()
    if (disabledChanged) patch.disabled   = draftDisabled
    if (valueChanged)    patch.text       = draftValue.trim()
    if (newTabChanged)   patch.linkTarget = draftNewTab ? '_blank' : ''
    onSave(patch)
  }

  function handleCancel() {
    setDraftText(originalText)
    setDraftHref(originalHref)
    setDraftDisabled(originalDisabled)
    setDraftValue(originalValue)
    setDraftNewTab(originalNewTab)
  }

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2">
        <KindIcon kind={kind} />
        <p className="text-[10px] text-gray-700 uppercase tracking-widest font-medium">Editable</p>
      </div>

      {showText && !showValue && (
        <EditField label="Text" value={draftText} placeholder="Element text…" onChange={setDraftText} />
      )}
      {showValue && (
        <EditField label="Value" value={draftValue} placeholder="Button value…" onChange={setDraftValue} />
      )}

      {showHref && (
        <EditField label="Href" value={draftHref} placeholder="https://…" onChange={setDraftHref} />
      )}

      {showHref && (
        <label className="flex items-center gap-2 mb-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={draftNewTab}
            onChange={(e) => setDraftNewTab(e.target.checked)}
            className="accent-blue-500"
          />
          <span className="text-[11px] text-gray-400">Open in new tab</span>
        </label>
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
