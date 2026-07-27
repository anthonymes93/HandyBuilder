import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

type HistoryEditType = 'text' | 'image' | 'link' | 'style' | 'ast-binding' | 'manual-edit' | 'delete'

interface HistoryElementMeta {
  tagName?: string
  id?: string | null
  classList?: string[]
}

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

  /** Write newText in place of oldText in the given file. Records one undo/redo history entry. */
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

  /** Write or merge a JSX inline style prop using source file + line metadata. Records one undo/redo history entry. */
  writeInlineStyle: (params: {
    filePath: string
    lineNumber: number
    styleProps: Record<string, string>
    tagName?: string
    projectPath: string
    description: string
    editType: HistoryEditType
    element?: HistoryElementMeta
  }) => ipcRenderer.invoke('editor:write-inline-style', params),

  /** Update a single property on an array item identified by a unique string value. Records one undo/redo history entry. */
  writeArrayItemProp: (params: {
    filePath: string
    itemId: string
    propName: string
    propValue: string
    projectPath: string
    description: string
    editType: HistoryEditType
    element?: HistoryElementMeta
  }) => ipcRenderer.invoke('editor:write-array-item-prop', params),

  /** Update a text field value inside a specific array item (find by itemId, replace oldText with newText). Records one undo/redo history entry. */
  updateArrayItemText: (params: {
    filePath: string
    itemId: string
    oldText: string
    newText: string
    projectPath: string
    description: string
    editType: HistoryEditType
    element?: HistoryElementMeta
  }) => ipcRenderer.invoke('editor:update-array-item-text', params),

  /** Parse the source file AST and resolve what produces the displayed text at a given line. */
  astLocateBinding: (params: {
    filePath: string
    lineNumber: number
    colNumber?: number | null
    displayedOld: string
    displayedNew: string
  }) => ipcRenderer.invoke('editor:ast-locate-binding', params),

  /** Update <img> src/alt/width/height attributes via Babel AST — dedicated image writer, never text search. Records one undo/redo history entry. */
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
  }) => ipcRenderer.invoke('editor:write-image-attrs', params),

  /**
   * Visual Button/Text style editor Save. Merges normal-state properties into
   * style={{}} (reconciling recognised Tailwind utilities); if hoverStyleProps
   * is given, attaches a stable hb-style-<id> class and writes/merges a
   * `:hover` rule into a shared project stylesheet. One atomic multi-file
   * transaction — a single Undo/Redo step covering both files.
   */
  writeElementStyle: (params: {
    filePath: string
    lineNumber: number
    colNumber?: number | null
    tagName?: string
    textContent?: string | null
    href?: string | null
    classList?: string[]
    pathname?: string | null
    itemId?: string | null
    normalStyleProps: Record<string, string>
    hoverStyleProps?: Record<string, string>
    projectPath: string
    description: string
    element?: HistoryElementMeta
    editScope?: 'instance' | 'shared'
    scopeFilePath?: string
    scopeLine?: number
  }) => ipcRenderer.invoke('editor:write-element-style', params),

  /** Replace the URL inside a `bg-[url(...)]` Tailwind arbitrary-value utility. Records one undo/redo history entry. */
  writeTailwindBgUrl: (params: {
    filePath: string
    lineNumber: number
    colNumber?: number | null
    tagName?: string
    newUrl: string
    projectPath: string
    description: string
    editType: HistoryEditType
    element?: HistoryElementMeta
  }) => ipcRenderer.invoke('editor:write-tailwind-bg-url', params),

  /** Replace the url() of a `background-image` declaration in a plain CSS rule (base class or ::before/::after). Records one undo/redo history entry. */
  writeCssBackgroundImage: (params: {
    filePath: string
    selectorText: string
    newUrl: string
    projectPath: string
    description: string
    editType: HistoryEditType
    element?: HistoryElementMeta
  }) => ipcRenderer.invoke('editor:write-css-background-image', params),

  /** Right-click / Delete-key element removal — AST-based. Records one undo/redo history entry. */
  deleteElement: (params: {
    directFile: string
    directLine: number
    directCol?: number | null
    ownerFile?: string | null
    ownerLine?: number | null
    ownerCol?: number | null
    ownerComponentName?: string | null
    hbItemId?: string | null
    mappedIndex?: number | null
    projectPath: string
    description: string
    element?: HistoryElementMeta
    operationId?: string
  }) => ipcRenderer.invoke('editor:delete-element', params),

  /** Open a file in the system default editor (e.g. VS Code). */
  openFileInEditor: (filePath: string) => ipcRenderer.invoke('editor:open-file', filePath),

  /** Reveal a file in the OS file manager. */
  showInFolder: (filePath: string) => ipcRenderer.invoke('editor:show-in-folder', filePath),

  // ── Edit history (Undo/Redo) ──────────────────────────────────────────────

  /** Current undo/redo stacks + recent entries for the History panel. */
  getHistoryState: (params: { projectPath: string }) =>
    ipcRenderer.invoke('history:get-state', params),

  /** Undo the most recent recorded edit — writes beforeContent back to disk. */
  undoHistory: (params: { projectPath: string }) =>
    ipcRenderer.invoke('history:undo', params),

  /** Redo the most recently undone edit — writes afterContent back to disk. */
  redoHistory: (params: { projectPath: string }) =>
    ipcRenderer.invoke('history:redo', params),

  /** Clear all edit history for a project. */
  clearHistory: (params: { projectPath: string }) =>
    ipcRenderer.invoke('history:clear', params),

  /** Drop history entries for one file — used after an external-change conflict. */
  discardFileHistory: (params: { projectPath: string; filePath: string }) =>
    ipcRenderer.invoke('history:discard-file', params)
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
