import type { HTMLAttributes, Ref } from 'react'
import { ElectronAPI } from '@electron-toolkit/preload'
import {
  FileNode, Project, ProjectOpenResult, DevServerStatus,
  TextEditAnalysis, CommitResult, ImagePickResult, ElementMapping,
  HistoryEditType, HistoryElementMeta, HistoryState, HistoryOpResult
} from '.'

interface WriteResult {
  success: boolean
  filePath?: string
  lineNumber?: number
  error?: string
  historyRecorded?: boolean
  skippedReason?: string
}

export interface HandyBuilderAPI {
  openProject: () => Promise<ProjectOpenResult | null>
  getProject: () => Promise<Project | null>
  getFileTree: () => Promise<FileNode[]>
  reloadPreview: () => Promise<void>
  openInBrowser: () => Promise<void>
  getDevServerUrl: () => Promise<string | null>
  onDevServerUrl: (callback: (url: string) => void) => void
  onDevServerLog: (callback: (log: string) => void) => void
  onDevServerStatus: (callback: (status: DevServerStatus) => void) => void
  removeAllListeners: (channel: string) => void
  getInspectorBridgePath: () => Promise<string>
  analyzeTextEdit: (params: {
    projectPath: string
    oldText: string
    newText: string
    tagName?: string
    id?: string | null
    classList?: string[]
    parentText?: string | null
    preferredFile?: string
  }) => Promise<TextEditAnalysis>
  analyzeLocatedEdit: (params: {
    filePath: string
    lineNumber: number
    oldText: string
    newText: string
  }) => Promise<TextEditAnalysis>
  commitTextEdit: (params: {
    filePath: string
    oldText: string
    newText: string
    actualMatchText?: string
    matchOffset?: number
    projectPath: string
    description: string
    editType: HistoryEditType
    element?: HistoryElementMeta
  }) => Promise<CommitResult>
  searchProject: (params: { projectPath: string; query: string; newText: string }) => Promise<TextEditAnalysis>
  getElementMapping: (params: { projectPath: string; key: string }) => Promise<ElementMapping | null>
  saveElementMapping: (params: { projectPath: string; mapping: ElementMapping }) => Promise<void>
  pickImageFile: () => Promise<ImagePickResult | { error: string } | null>
  readProjectFile: (params: { filePath: string; projectPath: string }) => Promise<{ content: string } | { error: string }>
  writeInlineStyle: (params: {
    filePath: string
    lineNumber: number
    styleProps: Record<string, string>
    tagName?: string
    projectPath: string
    description: string
    editType: HistoryEditType
    element?: HistoryElementMeta
  }) => Promise<WriteResult>
  writeArrayItemProp: (params: {
    filePath: string
    itemId: string
    propName: string
    propValue: string
    projectPath: string
    description: string
    editType: HistoryEditType
    element?: HistoryElementMeta
  }) => Promise<WriteResult>
  updateArrayItemText: (params: {
    filePath: string
    itemId: string
    oldText: string
    newText: string
    projectPath: string
    description: string
    editType: HistoryEditType
    element?: HistoryElementMeta
  }) => Promise<WriteResult>
  astLocateBinding: (params: {
    filePath: string
    lineNumber: number
    colNumber?: number | null
    displayedOld: string
    displayedNew: string
  }) => Promise<{
    success: boolean
    bindings: import('.').AstBinding[]
    reason: string
  }>
  writeImageAttrs: (params: {
    filePath: string
    lineNumber: number
    tagName?: string
    src?: string
    alt?: string
    width?: string
    height?: string
    projectPath: string
    description: string
    editType: HistoryEditType
    element?: HistoryElementMeta
  }) => Promise<WriteResult & { updatedAttrs?: string[] }>
  writeElementStyle: (params: {
    filePath: string
    lineNumber: number
    colNumber?: number | null
    tagName?: string
    textContent?: string | null
    href?: string | null
    classList?: string[]
    normalStyleProps: Record<string, string>
    hoverStyleProps?: Record<string, string>
    projectPath: string
    description: string
    element?: HistoryElementMeta
    editScope?: 'instance' | 'shared'
    scopeFilePath?: string
    scopeLine?: number
  }) => Promise<WriteResult & {
    hoverPersisted?: boolean
    hoverWarning?: string
    styleId?: string
    sharedComponentWarning?: string
    needsScopeChoice?: {
      componentName: string
      instanceFilePath: string
      instanceLine: number
      sharedFilePath?: string
      sharedLine?: number
      sharedForwardsProps?: boolean
    }
    diagnostics?: {
      reason: string
      candidates: Array<{ tagName: string; line: number; col: number; confidence: number; textPreview: string; hrefPreview: string | null }>
    }
  }>
  openFileInEditor: (filePath: string) => Promise<{ success: true } | { error: string }>
  showInFolder: (filePath: string) => Promise<void>

  // ── Edit history (Undo/Redo) ────────────────────────────────────────────
  getHistoryState: (params: { projectPath: string }) => Promise<HistoryState>
  undoHistory: (params: { projectPath: string }) => Promise<HistoryOpResult>
  redoHistory: (params: { projectPath: string }) => Promise<HistoryOpResult>
  clearHistory: (params: { projectPath: string }) => Promise<HistoryState>
  discardFileHistory: (params: { projectPath: string; filePath: string }) => Promise<HistoryState>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: HandyBuilderAPI
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: HTMLAttributes<HTMLElement> & {
        src?: string
        preload?: string
        allowpopups?: string
        webpreferences?: string
        ref?: Ref<HTMLElement>
      }
    }
  }
}
