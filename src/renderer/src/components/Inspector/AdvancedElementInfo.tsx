import { AlertTriangle, MapPin, ExternalLink } from 'lucide-react'
import { SelectedElement } from '../../types'
import { StyleAccordion } from './StyleAccordion'

/** Small, always-visible source-status pill (kept tiny per the new compact layout). */
export function SourceLocatedBadge({ element }: { element: SelectedElement }) {
  if (!element.hbSourceFile) {
    return (
      <div className="mx-3 mt-2 mb-1 flex items-center gap-1.5 rounded border border-red-800 bg-red-950/40 px-2 py-1">
        <AlertTriangle className="w-3 h-3 text-red-400 shrink-0" />
        <span className="text-red-300 text-[10px] font-medium">No source metadata</span>
      </div>
    )
  }
  return (
    <div className="mx-3 mt-2 mb-1 flex items-center gap-1.5 rounded border border-green-800 bg-green-950/30 px-2 py-1">
      <MapPin className="w-3 h-3 text-green-400 shrink-0" />
      <span className="text-green-300 text-[10px] font-medium">Source Located</span>
    </div>
  )
}

interface AdvancedElementInfoProps {
  element: SelectedElement
  onOpenFile: (filePath: string) => void
}

/** Collapsed-by-default dump of everything debugging needs: tag, classes, source, computed styles. */
export function AdvancedElementInfo({ element, onOpenFile }: AdvancedElementInfoProps) {
  const computed = element.computed as unknown as Record<string, string>

  return (
    <StyleAccordion title="Advanced">
      <div className="space-y-2 font-mono text-[10px]">
        <div className="flex justify-between gap-2">
          <span className="text-gray-600">tag</span>
          <span className="text-blue-400">&lt;{element.tagName}&gt;</span>
        </div>

        {element.classList.length > 0 && (
          <div>
            <p className="text-gray-600 mb-1">classes</p>
            <div className="flex flex-wrap gap-1">
              {element.classList.map((c) => (
                <span key={c} className="text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded">.{c}</span>
              ))}
            </div>
          </div>
        )}

        {element.hbSourceFile && (
          <>
            <div className="flex justify-between gap-2">
              <span className="text-gray-600 shrink-0">file</span>
              <span className="text-gray-300 break-all text-right" title={element.hbSourceFile}>
                {element.hbSourceFile.split('/').pop()}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-gray-600">line</span>
              <span className="text-gray-300">{element.hbSourceLine ?? '?'}</span>
            </div>
            {element.hbSourceCol != null && (
              <div className="flex justify-between gap-2">
                <span className="text-gray-600">col</span>
                <span className="text-gray-300">{element.hbSourceCol}</span>
              </div>
            )}
            <button
              onClick={() => onOpenFile(element.hbSourceFile!)}
              className="w-full flex items-center justify-center gap-1 px-2 py-1 text-[10px] text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded border border-gray-800 transition-colors"
            >
              <ExternalLink className="w-3 h-3" /> Open source file
            </button>
          </>
        )}

        {element.hbComponentName && (
          <div className="flex justify-between gap-2">
            <span className="text-gray-600">component</span>
            <span className="text-purple-300">{element.hbComponentName}</span>
          </div>
        )}

        {(element.hbItemId || element.hbStyleId) && (
          <div className="space-y-1 pt-1.5 border-t border-gray-800">
            {element.hbItemId && (
              <div className="flex justify-between gap-2">
                <span className="text-gray-600">data-hb-item-id</span>
                <span className="text-gray-400 truncate">{element.hbItemId}</span>
              </div>
            )}
            {element.hbStyleId && (
              <div className="flex justify-between gap-2">
                <span className="text-gray-600">hb-style-id</span>
                <span className="text-gray-400">{element.hbStyleId}</span>
              </div>
            )}
          </div>
        )}

        <details className="pt-1.5 border-t border-gray-800">
          <summary className="text-gray-600 cursor-pointer select-none">computed styles</summary>
          <div className="mt-1.5 space-y-0.5 max-h-40 overflow-y-auto">
            {Object.entries(computed).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2">
                <span className="text-gray-600 shrink-0">{k}</span>
                <span className="text-gray-400 truncate max-w-[130px]" title={v}>{v}</span>
              </div>
            ))}
          </div>
        </details>
      </div>
    </StyleAccordion>
  )
}
