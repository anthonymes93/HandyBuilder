import type { HTMLAttributes, Ref } from 'react'
import { ElectronAPI } from '@electron-toolkit/preload'
import {
  FileNode, Project, ProjectOpenResult, DevServerStatus,
  TextEditAnalysis, CommitResult, ImagePickResult, ElementMapping
} from '.'


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
  }) => Promise<{ success: boolean; filePath?: string; lineNumber?: number; error?: string }>
  writeArrayItemProp: (params: {
    filePath: string
    itemId: string
    propName: string
    propValue: string
  }) => Promise<{ success: boolean; filePath?: string; lineNumber?: number; error?: string }>
  openFileInEditor: (filePath: string) => Promise<{ success: true } | { error: string }>
  showInFolder: (filePath: string) => Promise<void>
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
