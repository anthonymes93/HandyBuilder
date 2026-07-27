import type { RefObject } from 'react'
import { FolderOpen, ExternalLink, X } from 'lucide-react'
import {
  Project, FileNode, DevServerStatus, SelectedElement,
  TextEditPayload, TextEditAnalysis, SourceMatch, SaveStatus,
  InspectorSavePatch, ImagePickResult, SaveResult, CommitResult, DomPatch, AstBinding,
  HistoryState, StyleScopeChoice, DeletionTarget, ElementIdentityLike
} from '../../types'
import { Toolbar } from '../Toolbar/Toolbar'
import { LeftSidebar } from '../LeftSidebar/LeftSidebar'
import { PreviewPanel } from '../Preview/PreviewPanel'
import { InspectorPanel } from '../Inspector/InspectorPanel'
import { MatchConfirmPanel } from '../Editor/MatchConfirmPanel'
import { BindingPickerPanel } from '../Editor/BindingPickerPanel'
import { SourceLocatorPanel } from '../Editor/SourceLocatorPanel'
import { SaveNotification } from '../Editor/SaveNotification'
import type { PreviewFrameHandle } from '../Preview/PreviewPanel'
import type { HbInjectionDiagnostic } from '../Preview/PreviewPanel'

interface AppLayoutProps {
  project: Project | null
  fileTree: FileNode[]
  isLoading: boolean
  devServerUrl: string | null
  devServerStatus: DevServerStatus
  hbLogs: string[]
  isInspectMode: boolean
  selectedElement: SelectedElement | null
  bridgePath: string | null
  previewRef: RefObject<PreviewFrameHandle>
  saveStatus: SaveStatus
  saveResult: SaveResult
  pendingAnalysis: TextEditAnalysis | null
  pendingAstBindings: AstBinding[]
  locatorPayload: TextEditPayload | null
  hbDiagnostic: HbInjectionDiagnostic | null
  hbDiagnosticError: string | null
  historyState: HistoryState
  historyNotice: string | null
  historyConflict: { kind: 'undo' | 'redo'; message: string; filePath: string } | null
  pendingScopeChoice: StyleScopeChoice | null
  onChooseScope: (scope: 'instance' | 'shared') => void
  onCancelScopeChoice: () => void
  onOpenProject: () => void
  onUndo: () => void
  onRedo: () => void
  onDismissHistoryNotice: () => void
  onDismissHistoryConflict: () => void
  onDiscardConflictFileHistory: () => void
  onReload: () => void
  onOpenInBrowser: () => void
  onToggleInspect: () => void
  onCheckHbInjection: () => void
  onCloseHbDiagnostic: () => void
  onElementSelected: (el: SelectedElement) => void
  onClearSelection: () => void
  onPageNavigated: () => void
  onTextSaved: (payload: TextEditPayload) => void
  onDeleteElement: (target: DeletionTarget, fallbackIdentity: ElementIdentityLike | null, operationId: string) => Promise<{ success: boolean; error?: string }>
  onConfirmMatch: (match: SourceMatch) => void
  onCancelConfirmation: () => void
  onConfirmAstBinding: (binding: AstBinding) => void
  onCancelAstPicker: () => void
  onInspectorSave: (patch: InspectorSavePatch) => Promise<boolean>
  onPickFile: () => Promise<ImagePickResult | null>
  onLivePatch: (patch: DomPatch) => void
  onRetryLastSave: () => void
  onOpenSourceLocator: (payload: TextEditPayload) => void
  onCloseSourceLocator: () => void
  onLocatorSave: (match: SourceMatch, newText: string) => Promise<CommitResult>
  onDismissSaveResult: () => void
  onOpenFile: (filePath: string) => void
  onShowInFolder: (filePath: string) => void
}

export function AppLayout({
  project,
  fileTree,
  isLoading,
  devServerUrl,
  devServerStatus,
  hbLogs,
  isInspectMode,
  selectedElement,
  bridgePath,
  previewRef,
  saveStatus,
  saveResult,
  pendingAnalysis,
  pendingAstBindings,
  locatorPayload,
  hbDiagnostic,
  hbDiagnosticError,
  historyState,
  historyNotice,
  historyConflict,
  pendingScopeChoice,
  onChooseScope,
  onCancelScopeChoice,
  onOpenProject,
  onUndo,
  onRedo,
  onDismissHistoryNotice,
  onDismissHistoryConflict,
  onDiscardConflictFileHistory,
  onReload,
  onOpenInBrowser,
  onToggleInspect,
  onCheckHbInjection,
  onCloseHbDiagnostic,
  onElementSelected,
  onClearSelection,
  onPageNavigated,
  onTextSaved,
  onDeleteElement,
  onConfirmMatch,
  onCancelConfirmation,
  onConfirmAstBinding,
  onCancelAstPicker,
  onInspectorSave,
  onPickFile,
  onLivePatch,
  onRetryLastSave,
  onOpenSourceLocator,
  onCloseSourceLocator,
  onLocatorSave,
  onDismissSaveResult,
  onOpenFile,
  onShowInFolder,
}: AppLayoutProps) {
  const showConfirmPanel  = saveStatus === 'needs-confirmation' && pendingAnalysis !== null
  const showBindingPicker = saveStatus === 'needs-binding-picker' && pendingAstBindings.length > 0
  const showLocator       = !!locatorPayload && !showConfirmPanel && !showBindingPicker

  console.log('[layout] render — saveStatus:', saveStatus, '| locatorPayload:', !!locatorPayload, '| showLocator:', showLocator, '| showConfirmPanel:', showConfirmPanel, '| showBindingPicker:', showBindingPicker)

  function rightPanel() {
    if (showConfirmPanel) {
      console.log('[layout] rightPanel → MatchConfirmPanel')
      return (
        <MatchConfirmPanel
          analysis={pendingAnalysis!}
          projectPath={project?.path ?? ''}
          onConfirm={onConfirmMatch}
          onCancel={onCancelConfirmation}
        />
      )
    }
    if (showBindingPicker) {
      console.log('[layout] rightPanel → BindingPickerPanel')
      return (
        <BindingPickerPanel
          bindings={pendingAstBindings}
          onConfirm={onConfirmAstBinding}
          onCancel={onCancelAstPicker}
        />
      )
    }
    if (showLocator) {
      console.log('[layout] rightPanel → SourceLocatorPanel')
      return (
        <SourceLocatorPanel
          payload={locatorPayload!}
          projectPath={project?.path ?? ''}
          fileTree={fileTree}
          onSave={onLocatorSave}
          onOpenFile={onOpenFile}
          onClose={onCloseSourceLocator}
        />
      )
    }
    console.log('[layout] rightPanel → InspectorPanel (locatorPayload=', locatorPayload, ')')
    return (
      <InspectorPanel
        selectedElement={selectedElement}
        saveStatus={saveStatus}
        hbLogs={hbLogs}
        onClearSelection={onClearSelection}
        onInspectorSave={onInspectorSave}
        onPickFile={onPickFile}
        onLivePatch={onLivePatch}
        onOpenFile={onOpenFile}
      />
    )
  }

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-100 overflow-hidden select-none">
      <Toolbar
        project={project}
        devServerStatus={devServerStatus}
        devServerUrl={devServerUrl}
        isInspectMode={isInspectMode}
        saveStatus={saveStatus}
        historyState={historyState}
        onUndo={onUndo}
        onRedo={onRedo}
        onReload={onReload}
        onOpenInBrowser={onOpenInBrowser}
        onToggleInspect={onToggleInspect}
        onCheckHbInjection={onCheckHbInjection}
      />

      {historyConflict && (
        <div className="shrink-0 px-4 py-2 bg-red-950/80 border-b border-red-900/60 flex items-center gap-3">
          <span className="flex-1 min-w-0 text-xs text-red-200">
            {historyConflict.message}
          </span>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => onOpenFile(historyConflict.filePath)}
              className="flex items-center gap-1 px-2 py-1 text-[11px] text-red-300 hover:text-red-100 hover:bg-red-900/40 rounded transition-colors"
              title="Open in default editor"
            >
              <ExternalLink className="w-3 h-3" />
              Open file
            </button>
            <button
              onClick={onDiscardConflictFileHistory}
              className="flex items-center gap-1 px-2 py-1 text-[11px] text-red-300 hover:text-red-100 hover:bg-red-900/40 rounded transition-colors"
              title="Discard undo/redo history for this file"
            >
              <FolderOpen className="w-3 h-3" />
              Discard history for this file
            </button>
            <button
              onClick={onDismissHistoryConflict}
              className="p-1 text-red-400/70 hover:text-red-200 rounded transition-colors"
              title="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {!historyConflict && historyNotice && (
        <div className="shrink-0 px-4 py-2 bg-gray-900 border-b border-gray-800 flex items-center gap-3">
          <span className="flex-1 min-w-0 text-xs text-gray-300">{historyNotice}</span>
          <button
            onClick={onDismissHistoryNotice}
            className="p-1 text-gray-600 hover:text-gray-300 rounded transition-colors"
            title="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <SaveNotification
        saveResult={saveResult}
        onRetry={onRetryLastSave}
        onDismiss={onDismissSaveResult}
        onOpenFile={onOpenFile}
        onShowInFolder={onShowInFolder}
        onOpenSourceLocator={() => {
          console.log('[layout] onOpenSourceLocator fired, retryPayload:', saveResult.retryPayload)
          if (!saveResult.retryPayload) {
            console.error('[layout] onOpenSourceLocator: saveResult.retryPayload is missing!')
            return
          }
          onOpenSourceLocator(saveResult.retryPayload)
        }}
      />

      <div className="flex flex-1 overflow-hidden">
        <LeftSidebar
          project={project}
          fileTree={fileTree}
          isLoading={isLoading}
          onOpenProject={onOpenProject}
        />
        <PreviewPanel
          ref={previewRef}
          url={devServerUrl}
          status={devServerStatus}
          project={project}
          isInspectMode={isInspectMode}
          bridgePath={bridgePath}
          onElementSelected={onElementSelected}
          onPageNavigated={onPageNavigated}
          onTextSaved={onTextSaved}
          onDeleteElement={onDeleteElement}
        />
        {rightPanel()}
      </div>
      {(hbDiagnostic || hbDiagnosticError) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={onCloseHbDiagnostic}>
          <div className="w-full max-w-3xl max-h-[85vh] overflow-auto rounded-lg border border-gray-700 bg-gray-900 p-5 shadow-2xl select-text" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-4 mb-4">
              <h2 className="text-sm font-semibold text-gray-100">HandyBuilder Injection Diagnostic</h2>
              <button className="text-xs text-gray-400 hover:text-white" onClick={onCloseHbDiagnostic}>Close</button>
            </div>
            {hbDiagnosticError ? (
              <p className="rounded bg-red-950/50 border border-red-800 p-3 text-xs text-red-300">{hbDiagnosticError}</p>
            ) : hbDiagnostic && (
              <div className="space-y-3 text-xs font-mono text-gray-300">
                {hbDiagnostic.failure && <p className="rounded bg-red-950/50 border border-red-800 p-3 text-red-300">{hbDiagnostic.failure}</p>}
                <p><span className="text-gray-500">Current URL:</span> {hbDiagnostic.currentUrl}</p>
                <p><span className="text-gray-500">Attributes exist:</span> file={String(hbDiagnostic.hasDataHbFile)}, line={String(hbDiagnostic.hasDataHbLine)}, col={String(hbDiagnostic.hasDataHbCol)}</p>
                <p><span className="text-gray-500">data-hb-file count:</span> {hbDiagnostic.metadataCount}</p>
                <p><span className="text-gray-500">Plugin global marker:</span> {String(hbDiagnostic.pluginActive)}</p>
                <div><p className="text-gray-500 mb-1">First 5 metadata elements:</p><pre className="whitespace-pre-wrap rounded bg-gray-950 p-3">{JSON.stringify(hbDiagnostic.sampleElements, null, 2)}</pre></div>
                <div><p className="text-gray-500 mb-1">Body HTML sample (first 1000 chars):</p><pre className="whitespace-pre-wrap break-all rounded bg-gray-950 p-3">{hbDiagnostic.bodyHtmlSample}</pre></div>
              </div>
            )}
          </div>
        </div>
      )}
      {pendingScopeChoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={onCancelScopeChoice}>
          <div className="w-full max-w-md rounded-lg border border-gray-700 bg-gray-900 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-sm font-semibold text-gray-100 mb-1">Apply style to:</h2>
            <p className="text-xs text-gray-500 mb-3">
              This button is rendered by the shared <span className="font-mono text-blue-400">&lt;{pendingScopeChoice.componentName}&gt;</span> component.
            </p>
            <div className="mb-4 rounded border border-gray-800 bg-gray-950/60 px-2.5 py-2 font-mono text-[10px] text-gray-500 space-y-0.5">
              <p>Target: <span className="text-gray-300">{pendingScopeChoice.instanceFilePath.split('/').pop()}:{pendingScopeChoice.instanceLine}</span></p>
              {pendingScopeChoice.identityItemId ? (
                <p>Target item: <span className="text-gray-300">{pendingScopeChoice.identityItemId}</span></p>
              ) : (
                <p>
                  Identity: <span className="text-gray-300">{pendingScopeChoice.identityText || '(no text)'}</span>
                  {pendingScopeChoice.identityHref && <> · <span className="text-gray-300">{pendingScopeChoice.identityHref}</span></>}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <button
                onClick={() => onChooseScope('instance')}
                className="w-full text-left px-3 py-2.5 rounded border border-blue-600 bg-blue-950/40 hover:bg-blue-950/70 transition-colors"
              >
                <p className="text-sm text-blue-300 font-medium">This button only</p>
                <p className="text-[11px] text-gray-500 mt-0.5">Adds a style to just this usage, in {pendingScopeChoice.instanceFilePath.split('/').pop()}.</p>
              </button>
              <button
                onClick={() => onChooseScope('shared')}
                disabled={!pendingScopeChoice.sharedFilePath}
                className="w-full text-left px-3 py-2.5 rounded border border-gray-700 hover:border-gray-600 hover:bg-gray-800/60 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <p className="text-sm text-gray-200 font-medium">
                  All buttons using {pendingScopeChoice.componentName}.tsx
                </p>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  {pendingScopeChoice.sharedFilePath
                    ? `Edits ${pendingScopeChoice.sharedFilePath.split('/').pop()} — affects every instance.`
                    : "Couldn't locate the component's definition file."}
                </p>
              </button>
            </div>
            <button
              onClick={onCancelScopeChoice}
              className="w-full mt-3 px-3 py-1.5 text-xs text-gray-500 hover:text-gray-300 rounded border border-gray-800 hover:border-gray-700 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
