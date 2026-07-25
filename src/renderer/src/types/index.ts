// ─── AST binding ─────────────────────────────────────────────────────────────

export interface AstBinding {
  kind: 'jsx-text' | 'jsx-text-partial' | 'identifier' | 'member' | 'jsx-attr' | 'jsx-attr-member'
  description: string
  filePath: string
  lineNumber: number
  oldText: string
  newText: string
  matchOffset: number
}

// ─────────────────────────────────────────────────────────────────────────────

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
  // Typography
  fontFamily: string
  fontWeight: string
  lineHeight: string
  letterSpacing: string
  textAlign: string
  textTransform: string
  textDecorationLine: string
  // Border
  borderTopWidth: string
  borderStyle: string
  borderColor: string
  borderTopLeftRadius: string
  borderTopRightRadius: string
  borderBottomRightRadius: string
  borderBottomLeftRadius: string
  // Size / layout
  width: string
  minWidth: string
  height: string
  display: string
  justifyContent: string
  alignItems: string
  // Effects
  opacity: string
  boxShadow: string
  transitionDuration: string
}

/**
 * The full set of camelCase CSS properties the visual style editors
 * (ButtonStyleEditor / TextStyleEditor) can read, live-patch, and save.
 * Values are raw CSS strings (no unit assumptions beyond what's in the string).
 */
export interface StyleProps {
  // typography
  fontFamily?: string
  fontSize?: string
  fontWeight?: string
  lineHeight?: string
  letterSpacing?: string
  textAlign?: string
  textTransform?: string
  textDecoration?: string
  // colours
  color?: string
  backgroundColor?: string
  borderColor?: string
  // border
  borderWidth?: string
  borderStyle?: string
  borderRadius?: string
  borderTopLeftRadius?: string
  borderTopRightRadius?: string
  borderBottomRightRadius?: string
  borderBottomLeftRadius?: string
  // spacing
  paddingTop?: string
  paddingRight?: string
  paddingBottom?: string
  paddingLeft?: string
  marginTop?: string
  marginRight?: string
  marginBottom?: string
  marginLeft?: string
  // size / alignment
  width?: string
  minWidth?: string
  maxWidth?: string
  height?: string
  display?: string
  justifyContent?: string
  alignItems?: string
  gap?: string
  flexDirection?: string
  // effects
  opacity?: string
  boxShadow?: string
  transform?: string
  transitionDuration?: string
}

export type StyleState = 'normal' | 'hover'

export interface SelectedElement {
  tagName: string
  id: string | null
  classList: string[]
  textContent: string | null
  rect: ElementRect
  computed: ComputedStyles
  // Link / button
  href?: string | null
  linkTarget?: string | null
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
  hbSourceEndLine?: number | null
  hbSourceEndCol?:  number | null
  /** The literal JSX tag authored at hbSourceLine/hbSourceCol, e.g. "a" or "Button". */
  hbSourceTag?:     string | null
  /** Where hbSourceFile/Line came from: direct data-hb-* on this element, a parent's, or React fiber fallback. */
  hbSourceOrigin?:  'direct' | 'parent' | 'fiber' | null
  hbComponentName?: string | null
  // Per-item identifier for elements inside .map() (from data-hb-item-id attribute)
  hbItemId?: string | null
  // Set when a click was resolved up to a closer ancestor (e.g. 'div' means div → a)
  resolvedFrom?: string | null
  // Stable per-element style class (hb-style-<id>), present once a hover style
  // has been saved for this element at least once. Deterministic from source location.
  hbStyleId?: string | null
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
  // Per-item identifier for elements inside .map() (from data-hb-item-id, walked up DOM)
  hbItemId?: string | null
  // Which element field this save represents — drives the history description
  // and editType (link edits are tagged 'style'-adjacent 'link', not 'text').
  editKind?: 'text' | 'href'
  /** Human-readable history entry description (e.g. "Changed heading text"). Falls back to a generated one if omitted. */
  description?: string
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
  historyRecorded?: boolean
  skippedReason?: string
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
  /** Populated when status is needs-binding-picker; multiple AST bindings found. */
  astBindings?: AstBinding[]
}

/** A patch the host sends the bridge to apply to the selected DOM element. */
export interface DomPatch {
  // text / link / button
  text?: string
  href?: string
  linkTarget?: string
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
  /**
   * Generic resolved style bag for the visual Button/Text style editors — sent
   * as ONE full snapshot per change (already merged: normal, or normal+hover
   * when hover-preview mode is active). The bridge diffs against whatever it
   * last applied and clears any keys no longer present.
   */
  styleProps?: Partial<StyleProps>
  /** Remove all HandyBuilder-applied inline style overrides (used by Cancel). */
  clearStyleProps?: true
}

/** What the Inspector form submits when the user clicks Save. */
export interface InspectorSavePatch {
  element: SelectedElement
  // text / link / button
  text?: string
  href?: string
  linkTarget?: string
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
  // Button/Text visual style editor — present only when saving from those editors.
  styleNormal?: Partial<StyleProps>
  styleHover?: Partial<StyleProps>
  /** Human-readable history description, e.g. "Changed button style". */
  styleDescription?: string
  /** Set once the user has answered the "this instance only" vs "shared component" prompt. */
  styleEditScope?: 'instance' | 'shared'
  styleScopeFilePath?: string
  styleScopeLine?: number
}

/** Shown when a style Save targets a component invocation (e.g. <Button>) rather than an intrinsic tag. */
export interface StyleScopeChoice {
  componentName: string
  instanceFilePath: string
  instanceLine: number
  sharedFilePath?: string
  sharedLine?: number
  sharedForwardsProps?: boolean
}

export interface StyleDiagnosticCandidate {
  tagName: string
  line: number
  col: number
  confidence: number
  textPreview: string
  hrefPreview: string | null
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
  | 'needs-binding-picker'
  | 'failed'

// ─── edit history (Undo/Redo) ─────────────────────────────────────────────────

export type HistoryEditType = 'text' | 'image' | 'link' | 'style' | 'ast-binding' | 'manual-edit'

export interface HistoryElementMeta {
  tagName?: string
  id?: string | null
  classList?: string[]
}

/** One entry as shown in the History panel — no file-content snapshots. */
export interface HistoryEntrySummary {
  id: string
  timestamp: number
  editType: HistoryEditType
  filePath: string
  fileCount: number
  sourceLine?: number
  description: string
  element?: HistoryElementMeta
}

export interface HistoryState {
  /** Newest first. */
  entries: HistoryEntrySummary[]
  cursor: number
  canUndo: boolean
  canRedo: boolean
  undoDescription?: string
  redoDescription?: string
}

export interface HistoryOpResult {
  success: boolean
  error?: string
  /** True when the file on disk didn't match what HandyBuilder expected — nothing was overwritten. */
  conflict?: boolean
  description?: string
  filePath?: string
  state: HistoryState
}
