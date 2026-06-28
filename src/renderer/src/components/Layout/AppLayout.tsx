import type { RefObject } from 'react'
import {
  Project, FileNode, DevServerStatus, SelectedElement,
  TextEditPayload, TextEditAnalysis, SourceMatch, SaveStatus,
  InspectorSavePatch, ImagePickResult, SaveResult, CommitResult
} from '../../types'
import { Toolbar } from '../Toolbar/Toolbar'
import { LeftSidebar } from '../LeftSidebar/LeftSidebar'
import { PreviewPanel } from '../Preview/PreviewPanel'
import { InspectorPanel } from '../Inspector/InspectorPanel'
import { MatchConfirmPanel } from '../Editor/MatchConfirmPanel'
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
  locatorPayload: TextEditPayload | null
  hbDiagnostic: HbInjectionDiagnostic | null
  hbDiagnosticError: string | null
  onOpenProject: () => void
  onReload: () => void
  onOpenInBrowser: () => void
  onToggleInspect: () => void
  onCheckHbInjection: () => void
  onCloseHbDiagnostic: () => void
  onElementSelected: (el: SelectedElement) => void
  onClearSelection: () => void
  onPageNavigated: () => void
  onTextSaved: (payload: TextEditPayload) => void
  onConfirmMatch: (match: SourceMatch) => void
  onCancelConfirmation: () => void
  onInspectorSave: (patch: InspectorSavePatch) => void
  onPickFile: () => Promise<ImagePickResult | null>
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
  locatorPayload,
  hbDiagnostic,
  hbDiagnosticError,
  onOpenProject,
  onReload,
  onOpenInBrowser,
  onToggleInspect,
  onCheckHbInjection,
  onCloseHbDiagnostic,
  onElementSelected,
  onClearSelection,
  onPageNavigated,
  onTextSaved,
  onConfirmMatch,
  onCancelConfirmation,
  onInspectorSave,
  onPickFile,
  onRetryLastSave,
  onOpenSourceLocator,
  onCloseSourceLocator,
  onLocatorSave,
  onDismissSaveResult,
  onOpenFile,
  onShowInFolder,
}: AppLayoutProps) {
  const showConfirmPanel  = saveStatus === 'needs-confirmation' && pendingAnalysis !== null
  const showLocator       = !!locatorPayload && !showConfirmPanel

  console.log('[layout] render — saveStatus:', saveStatus, '| locatorPayload:', !!locatorPayload, '| showLocator:', showLocator, '| showConfirmPanel:', showConfirmPanel)

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
        onReload={onReload}
        onOpenInBrowser={onOpenInBrowser}
        onToggleInspect={onToggleInspect}
        onCheckHbInjection={onCheckHbInjection}
      />

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
    </div>
  )
}
