export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

export interface Project {
  path: string
  name: string
}

export type DevServerStatus = 'idle' | 'installing' | 'starting' | 'running' | 'stopped' | 'error'

export interface ProjectOpenResult {
  project: Project
  fileTree: FileNode[]
}

export interface ElementRect {
  width: number
  height: number
}

export interface ComputedStyles {
  marginTop: string
  marginRight: string
  marginBottom: string
  marginLeft: string
  paddingTop: string
  paddingRight: string
  paddingBottom: string
  paddingLeft: string
  fontSize: string
  color: string
  backgroundColor: string
  objectFit: string
  objectPosition: string
  backgroundImage: string
  backgroundSize: string
  backgroundPosition: string
  transform: string
}

export interface SelectedElement {
  tagName: string
  id: string | null
  classList: string[]
  textContent: string | null
  rect: ElementRect
  computed: ComputedStyles
  // Link / button
  href?: string | null
  inputType?: string | null
  disabled?: boolean
  value?: string | null
  role?: string | null
  // Image
  imageSrc?: string | null
  imageAlt?: string | null
  imageWidth?: string | null
  imageHeight?: string | null
  // Source metadata from Vite plugin data-hb-* attrs or React fiber _debugSource
  hbSourceFile?:    string | null
  hbSourceLine?:    number | null
  hbSourceCol?:     number | null
  hbComponentName?: string | null
  // Per-item identifier for elements inside .map() (from data-hb-item-id attribute)
  hbItemId?: string | null
}

/** Typed interface for Electron's <webview> element used in PreviewPanel. */
export interface WebviewElement extends HTMLElement {
  src: string
  preload: string
  send(channel: string, ...args: unknown[]): void
  executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T>
  addEventListener(event: 'ipc-message', listener: (e: IpcMessageEvent) => void): void
  addEventListener(event: 'dom-ready', listener: () => void): void
  addEventListener(event: 'did-start-loading', listener: () => void): void
  removeEventListener(event: 'ipc-message', listener: (e: IpcMessageEvent) => void): void
  removeEventListener(event: 'dom-ready', listener: () => void): void
  removeEventListener(event: 'did-start-loading', listener: () => void): void
}

export interface IpcMessageEvent extends Event {
  readonly channel: string
  readonly args: unknown[]
}

// ─── text / field editing ────────────────────────────────────────────────────

export interface TextEditPayload {
  tagName: string
  oldText: string
  newText: string
  // Element context — used to rank source matches
  id?: string | null
  classList?: string[]
  href?: string | null
  parentText?: string | null
  siblingBefore?: string | null
  siblingAfter?: string | null
  pathname?: string
  // Source metadata (from Vite plugin data-hb-* attrs or React fiber _debugSource)
  sourceFile?: string
  sourceLine?: number
  sourceCol?: number
  editedTagName?: string
  editedText?: string
  editedTextContentSample?: string
  editedElementHasChildren?: boolean
}

export type MatchStrategy = 'exact' | 'normalized' | 'jsx-word-proximity'

export interface SourceMatch {
  filePath: string
  lineNumber: number
  lineText: string
  contextBefore: string
  contextAfter: string
  matchOffset: number
  matchStrategy: MatchStrategy
  actualMatchText: string
  /** 0–100 confidence that this is the correct source location. */
  confidence: number
}

export interface AnalysisDebugInfo {
  strategy: MatchStrategy | 'none'
  filesScanned: number
  extensionsSearched: string[]
  normalizedSearchText: string
  projectPath: string
  sourceFile?: string
  originalLine?: number
  searchedFromLine?: number
  searchedToLine?: number
}

export interface TextEditAnalysis {
  oldText: string
  newText: string
  matchCount: number
  matches: SourceMatch[]
  /** True when all matches are low-confidence — force MatchConfirmPanel. */
  needsConfirmation?: boolean
  /** Present when the main process is up-to-date; absent on older builds. */
  debugInfo?: AnalysisDebugInfo
}

export interface CommitResult {
  success: boolean
  filePath?: string
  lineNumber?: number
  oldText?: string
  newText?: string
  bytesWritten?: number
  error?: string
}

export interface SaveDebugInfo {
  /** Raw text captured from DOM */
  originalText: string
  /** After entity decode + whitespace collapse */
  normalizedText: string
  filesScanned: number
  extensions: string[]
  projectPath: string
  strategy: string
  sourceFile?: string
  originalLine?: number
  searchedFromLine?: number
  searchedToLine?: number
  oldTextSent?: string
  newTextSent?: string
  editedTagName?: string
  editedTextContentSample?: string
  editedElementHasChildren?: boolean
}

/** Full detail of the last save attempt — drives SaveNotification. */
export interface SaveResult {
  status: SaveStatus
  filePath?: string
  relativePath?: string
  lineNumber?: number
  error?: string
  retryPayload?: TextEditPayload
  /** Populated when status is dom-only; shows why the search failed. */
  debugInfo?: SaveDebugInfo
}

/** A patch the host sends the bridge to apply to the selected DOM element. */
export interface DomPatch {
  // text / link / button
  text?: string
  href?: string
  disabled?: boolean
  // image
  imageSrc?: string
  imageAlt?: string
  imageWidth?: string
  imageHeight?: string
  objectFit?: string
  objectPosition?: string
  backgroundImage?: string
  backgroundSize?: string
  backgroundPosition?: string
  transform?: string
}

/** What the Inspector form submits when the user clicks Save. */
export interface InspectorSavePatch {
  element: SelectedElement
  // text / link / button
  text?: string
  href?: string
  disabled?: boolean
  // image
  imageSrc?: string
  imageAlt?: string
  imageWidth?: string
  imageHeight?: string
  objectFit?: string
  objectPosition?: string
  backgroundImage?: string
  backgroundSize?: string
  backgroundPosition?: string
  transform?: string
}

/** Returned by the image file-picker IPC call. */
export interface ImagePickResult {
  /** URL the browser (dev server) can load, e.g. /images/photo.jpg */
  url: string
  /** Path relative to project root, e.g. public/images/photo.jpg */
  relativePath: string
}

/** Stored mapping from an element key to a confirmed source location. */
export interface ElementMapping {
  key: string
  tagName: string
  id: string | null
  classList: string[]
  oldText: string
  filePath: string
  lineNumber?: number
  lastUsed: number
}

export type SaveStatus =
  | 'idle'
  | 'saving'
  | 'saved'
  | 'dom-only'
  | 'needs-confirmation'
  | 'failed'
