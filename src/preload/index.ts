import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  openProject: () => ipcRenderer.invoke('project:open'),
  getProject: () => ipcRenderer.invoke('project:get'),
  getFileTree: () => ipcRenderer.invoke('project:file-tree'),
  reloadPreview: () => ipcRenderer.invoke('preview:reload'),
  openInBrowser: () => ipcRenderer.invoke('preview:open-in-browser'),
  getDevServerUrl: () => ipcRenderer.invoke('devserver:get-url'),

  onDevServerUrl: (callback: (url: string) => void) =>
    ipcRenderer.on('devserver:url', (_e, url: string) => callback(url)),
  onDevServerLog: (callback: (log: string) => void) =>
    ipcRenderer.on('devserver:log', (_e, log: string) => callback(log)),
  onDevServerStatus: (callback: (status: string) => void) =>
    ipcRenderer.on('devserver:status', (_e, status: string) => callback(status)),

  removeAllListeners: (channel: string) => ipcRenderer.removeAllListeners(channel),

  getInspectorBridgePath: (): Promise<string> =>
    ipcRenderer.invoke('inspector:get-bridge-path'),

  /** Scan the project for all source occurrences of oldText. Never writes. */
  analyzeTextEdit: (params: {
    projectPath: string
    oldText: string
    newText: string
    tagName?: string
    id?: string | null
    classList?: string[]
    parentText?: string | null
    preferredFile?: string
  }) => ipcRenderer.invoke('editor:analyze-text', params),

  /** Search a single file near a known line — fast path when source metadata is available. */
  analyzeLocatedEdit: (params: {
    filePath: string
    lineNumber: number
    oldText: string
    newText: string
  }) => ipcRenderer.invoke('editor:analyze-located', params),

  /** Write newText in place of oldText in the given file. */
  commitTextEdit: (params: {
    filePath: string
    oldText: string
    newText: string
    actualMatchText?: string
    matchOffset?: number
  }) => ipcRenderer.invoke('editor:commit-text-edit', params),

  /** Search the project with any query — used by the Source Locator panel. */
  searchProject: (params: { projectPath: string; query: string; newText: string }) =>
    ipcRenderer.invoke('editor:search-project', params),

  /** Get the stored element→source mapping for a given key. */
  getElementMapping: (params: { projectPath: string; key: string }) =>
    ipcRenderer.invoke('editor:get-mapping', params),

  /** Save a confirmed element→source mapping for future use. */
  saveElementMapping: (params: { projectPath: string; mapping: {
    key: string; tagName: string; id: string | null; classList: string[];
    oldText: string; filePath: string; lineNumber?: number; lastUsed: number
  }}) => ipcRenderer.invoke('editor:save-mapping', params),

  /** Open a native file picker constrained to the project folder. */
  pickImageFile: () => ipcRenderer.invoke('image:pick-file'),

  /** Read a project file's text content for manual line picking in the Source Locator. */
  readProjectFile: (params: { filePath: string; projectPath: string }) =>
    ipcRenderer.invoke('editor:read-file', params),

  /** Open a file in the system default editor (e.g. VS Code). */
  openFileInEditor: (filePath: string) => ipcRenderer.invoke('editor:open-file', filePath),

  /** Reveal a file in the OS file manager. */
  showInFolder: (filePath: string) => ipcRenderer.invoke('editor:show-in-folder', filePath)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
