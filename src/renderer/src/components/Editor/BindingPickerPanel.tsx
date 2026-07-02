import { AstBinding } from '../../types'

interface BindingPickerPanelProps {
  bindings: AstBinding[]
  onConfirm: (binding: AstBinding) => void
  onCancel: () => void
}

const KIND_LABELS: Record<AstBinding['kind'], string> = {
  'jsx-text':         'Literal text',
  'jsx-text-partial': 'Text node (mixed content)',
  'identifier':       'Variable',
  'member':           'Object property',
  'jsx-attr':         'JSX prop (string)',
  'jsx-attr-member':  'JSX prop (expression)',
}

export function BindingPickerPanel({ bindings, onConfirm, onCancel }: BindingPickerPanelProps) {
  return (
    <div className="w-60 flex flex-col bg-gray-900 border-l border-gray-800 shrink-0 overflow-hidden">
      <div className="h-9 flex items-center px-3 border-b border-gray-800 shrink-0">
        <span className="text-gray-500 text-[11px] font-medium uppercase tracking-widest">
          Choose Source
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
        <p className="text-[11px] text-gray-500 leading-relaxed mb-1">
          Multiple source locations could produce this text. Choose which one to update:
        </p>

        {bindings.map((binding, i) => (
          <button
            key={i}
            onClick={() => onConfirm(binding)}
            className="w-full text-left px-3 py-2.5 bg-gray-800 hover:bg-gray-750 border border-gray-700 hover:border-gray-600 rounded-lg transition-colors group"
          >
            <div className="text-[10px] text-blue-400 font-mono uppercase tracking-wider mb-0.5">
              {KIND_LABELS[binding.kind] ?? binding.kind}
            </div>
            <div className="text-[11px] text-gray-300 font-mono truncate">
              {binding.description}
            </div>
            <div className="text-[10px] text-gray-600 mt-0.5">
              Line {binding.lineNumber} · {binding.filePath.split('/').pop()}
            </div>
          </button>
        ))}

        <button
          onClick={onCancel}
          className="mt-1 px-3 py-1.5 text-gray-500 hover:text-gray-300 text-xs border border-gray-800 hover:border-gray-700 rounded transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
