/**
 * Inspector bridge — runs as a webview preload inside the user's project page.
 * Uses ipcRenderer.sendToHost to push data to the host renderer.
 * Uses ipcRenderer.on to receive commands from the host.
 * The page itself has no node integration and never sees these APIs.
 */
import { ipcRenderer } from 'electron'

log('bridge preload loaded')

// ─── logging ─────────────────────────────────────────────────────────────────

function log(msg: string): void {
  console.log(`[bridge] ${msg}`)
  try { ipcRenderer.sendToHost('bridge:log', msg) } catch { /* ignore — host not ready yet */ }
}

// ─── outline constants ────────────────────────────────────────────────────────

const HOVER_OUTLINE  = '2px dashed rgba(59, 130, 246, 0.75)'
const SELECT_OUTLINE = '2px solid rgb(59, 130, 246)'
const EDIT_OUTLINE   = '2px solid rgb(34, 197, 94)'

// ─── inspect state ────────────────────────────────────────────────────────────

const state = {
  enabled:  false,
  hovered:  null as HTMLElement | null,
  selected: null as HTMLElement | null,
}

function setOutline(el: HTMLElement, value: string): void {
  el.style.outline       = value
  el.style.outlineOffset = value ? '1px' : ''
}

function clearHover(): void {
  if (state.hovered && state.hovered !== state.selected) setOutline(state.hovered, '')
  state.hovered = null
}

function clearSelected(): void {
  if (state.selected) { setOutline(state.selected, ''); state.selected = null }
}

function collectData(el: HTMLElement) {
  const rect = el.getBoundingClientRect()
  const cs   = window.getComputedStyle(el)
  const a    = el as HTMLAnchorElement
  const inp  = el as HTMLInputElement
  const btn  = el as HTMLButtonElement
  const img  = el as HTMLImageElement

  const isImg = el.tagName === 'IMG'

  const { sourceFile, sourceLine, sourceCol, componentName } = getSourceInfo(el)
  log(`[bridge] selected source info: file=${sourceFile ?? 'NONE'} line=${sourceLine ?? 'NONE'} component=${componentName ?? 'NONE'}`)

  return {
    tagName:     el.tagName.toLowerCase(),
    id:          el.id || null,
    classList:   Array.from(el.classList),
    textContent: (el.textContent ?? '').trim().slice(0, 150) || null,
    rect: { width: Math.round(rect.width), height: Math.round(rect.height) },
    computed: {
      marginTop: cs.marginTop, marginRight: cs.marginRight,
      marginBottom: cs.marginBottom, marginLeft: cs.marginLeft,
      paddingTop: cs.paddingTop, paddingRight: cs.paddingRight,
      paddingBottom: cs.paddingBottom, paddingLeft: cs.paddingLeft,
      fontSize: cs.fontSize, color: cs.color, backgroundColor: cs.backgroundColor,
      objectFit: cs.objectFit,
      backgroundImage: cs.backgroundImage,
    },
    href:      'href'      in el ? (a.getAttribute('href') ?? null) : null,
    inputType: 'type'      in el ? (inp.type || null) : null,
    disabled:  'disabled'  in el ? btn.disabled : undefined,
    value:     'value'     in el && el.tagName === 'INPUT' ? inp.value || null : null,
    role:      el.getAttribute('role') ?? null,
    imageSrc:    isImg ? (img.getAttribute('src') ?? null) : null,
    imageAlt:    isImg ? (img.getAttribute('alt') ?? null) : null,
    imageWidth:  isImg ? (img.getAttribute('width') ?? (img.style.width || null)) : null,
    imageHeight: isImg ? (img.getAttribute('height') ?? (img.style.height || null)) : null,
    // Source metadata — populated from data-hb-* attrs (Vite plugin) or React fiber _debugSource
    hbSourceFile:    sourceFile    ?? null,
    hbSourceLine:    sourceLine    ?? null,
    hbSourceCol:     sourceCol     ?? null,
    hbComponentName: componentName ?? null,
  }
}

// ─── inline-editable tag list ─────────────────────────────────────────────────
// Only elements in this set can be double-click–edited inline.
// Container elements (div, section, article…) are intentionally excluded to
// avoid accidentally making large regions of the page editable.

const INLINE_EDITABLE = new Set([
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'P', 'SPAN', 'A', 'BUTTON', 'LABEL',
  'LI', 'TD', 'TH', 'DT', 'DD',
  'STRONG', 'EM', 'B', 'I', 'U', 'S',
  'SMALL', 'MARK', 'CODE', 'FIGCAPTION',
  'CAPTION', 'LEGEND', 'SUMMARY', 'BLOCKQUOTE',
])

function canEdit(el: HTMLElement): boolean {
  if (!INLINE_EDITABLE.has(el.tagName)) {
    log(`canEdit → false: <${el.tagName.toLowerCase()}> not in editable tag list`)
    return false
  }
  const text = (el.textContent ?? '').trim()
  if (!text) {
    log(`canEdit → false: <${el.tagName.toLowerCase()}> has no text content`)
    return false
  }
  log(`canEdit → true: <${el.tagName.toLowerCase()}> "${text.slice(0, 30)}"`)
  return true
}

function deepestEditableAtPoint(x: number, y: number, fallback: HTMLElement): HTMLElement | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (clientX: number, clientY: number) => Range | null
  }
  const textNode = doc.caretRangeFromPoint?.(x, y)?.startContainer
  let current = textNode?.parentElement ?? fallback
  while (current && !INLINE_EDITABLE.has(current.tagName)) current = current.parentElement

  // Mixed-content JSX such as <h1>text<br/><span>text</span></h1> cannot be
  // searched as one contiguous string. Isolate the exact direct text node under
  // the cursor so editing it never captures the parent heading/container text.
  if (current && textNode?.nodeType === Node.TEXT_NODE && textNode.parentElement === current && current.childElementCount > 0) {
    const wrapper = document.createElement('span')
    wrapper.dataset.hbTemporaryTextEditor = 'true'
    wrapper.dataset.hbOriginalTag = current.tagName.toLowerCase()
    wrapper.dataset.hbOriginalHadChildren = 'true'
    textNode.replaceWith(wrapper)
    wrapper.appendChild(textNode)
    return wrapper
  }

  if (current) return current
  const deepest = document.elementsFromPoint(x, y).find(
    (node) => node instanceof HTMLElement && INLINE_EDITABLE.has(node.tagName)
  )
  if (deepest instanceof HTMLElement) return deepest
  return current
}

// ─── double-click detection ───────────────────────────────────────────────────
// We detect double-clicks manually inside onClick rather than relying on the
// browser's "dblclick" event.  The reason: our onClick handler calls
// e.stopPropagation() in the capture phase on every click, which in Chromium
// prevents the browser from synthesising the subsequent dblclick event.
// Tracking two rapid clicks on the same target is equivalent and fully reliable.

const DBLCLICK_MS = 350  // threshold in ms

let lastClickMs = 0
let lastClickEl: EventTarget | null = null

// ─── click / hover handlers ───────────────────────────────────────────────────

function onClick(e: MouseEvent): void {
  // While in edit mode, don't intercept — let contenteditable handle clicks.
  if (editState.active) return

  e.preventDefault()
  e.stopPropagation()

  const target = e.target as HTMLElement
  const now    = Date.now()

  // ── double-click detected ──────────────────────────────────────────────────
  if (now - lastClickMs < DBLCLICK_MS && lastClickEl === target) {
    log(`double-click detected on <${target.tagName.toLowerCase()}>`)
    lastClickMs = 0
    lastClickEl = null

    const editTarget = deepestEditableAtPoint(e.clientX, e.clientY, target)
    if (editTarget && canEdit(editTarget)) {
      enterEditMode(editTarget)
    }
    return
  }

  // ── single click: select element ───────────────────────────────────────────
  lastClickMs = now
  lastClickEl = target

  log(`click on <${target.tagName.toLowerCase()}>`)
  clearSelected()
  state.selected = target
  setOutline(target, SELECT_OUTLINE)
  if (state.hovered === target) state.hovered = null
  ipcRenderer.sendToHost('inspector:selected', collectData(target))
}

function onMouseOver(e: MouseEvent): void {
  if (editState.active) return
  const target = e.target as HTMLElement
  if (target === state.hovered) return
  clearHover()
  state.hovered = target
  if (target !== state.selected) setOutline(target, HOVER_OUTLINE)
}

function onMouseOut(e: MouseEvent): void {
  if (editState.active) return
  const target = e.target as HTMLElement
  if (target !== state.selected) setOutline(target, '')
  if (state.hovered === target) state.hovered = null
}

// ─── source metadata extraction ──────────────────────────────────────────────

interface SourceInfo {
  sourceFile?:     string
  sourceLine?:     number
  sourceCol?:      number
  componentName?:  string
}

function getSourceInfo(el: HTMLElement): SourceInfo {
  // ── try data-hb-* attributes first (injected by our Vite plugin) ──────────
  const hbFile = el.getAttribute('data-hb-file')
  const hbLine = el.getAttribute('data-hb-line')
  if (hbFile) {
    log(`[bridge] source via data-hb-*: ${hbFile}:${hbLine ?? '?'}`)
    return {
      sourceFile: hbFile,
      sourceLine: hbLine ? parseInt(hbLine, 10) : undefined,
    }
  }

  // ── fall back to React fiber _debugSource ─────────────────────────────────
  // @vitejs/plugin-react in dev mode asks Babel to include __source info on
  // every JSX element; React stores it on fiber._debugSource = {fileName, lineNumber, columnNumber}.
  try {
    const fiberKey = Object.keys(el).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
    )
    if (!fiberKey) {
      log('[bridge] no React fiber key found on element — React not running here?')
      return {}
    }

    // The host-component fiber (e.g. the <h1> fiber) should already carry _debugSource.
    // Walk upward only as a fallback in case it is missing on the immediate fiber.
    let fiber: Record<string, unknown> | null = (el as unknown as Record<string, unknown>)[fiberKey] as Record<string, unknown>
    let depth = 0
    while (fiber && depth < 10) {
      const src = fiber._debugSource as { fileName?: string; lineNumber?: number; columnNumber?: number } | undefined
      if (src?.fileName) {
        // Also try to grab the component name from the fiber that owns this element
        let componentName: string | undefined
        try {
          const owner = fiber._debugOwner as Record<string, unknown> | null
          if (owner) {
            const t = owner.type as ((...a: unknown[]) => unknown) | { displayName?: string; name?: string } | null
            componentName = typeof t === 'function'
              ? (t as { displayName?: string; name?: string }).displayName ?? t.name ?? undefined
              : typeof t === 'object' && t !== null
                ? (t as { displayName?: string; name?: string }).displayName ?? (t as { name?: string }).name ?? undefined
                : undefined
          }
        } catch { /* ignore */ }
        log(`[bridge] source via fiber at depth ${depth}: ${src.fileName}:${src.lineNumber} owner=${componentName ?? 'unknown'}`)
        return { sourceFile: src.fileName, sourceLine: src.lineNumber, sourceCol: src.columnNumber, componentName }
      }
      fiber = (fiber.return as Record<string, unknown> | null)
      depth++
    }
    log(`[bridge] fiber found but _debugSource missing after ${depth} levels — JSX source transform not active?`)
  } catch (err) {
    log(`[bridge] fiber access threw: ${String(err)}`)
  }

  return {}
}

function getClosestSourceInfo(el: HTMLElement): SourceInfo {
  let current: HTMLElement | null = el
  while (current) {
    const file = current.getAttribute('data-hb-file')
    if (file) {
      const line = current.getAttribute('data-hb-line')
      const col = current.getAttribute('data-hb-col')
      return {
        sourceFile: file,
        sourceLine: line ? parseInt(line, 10) : undefined,
        sourceCol: col ? parseInt(col, 10) : undefined,
      }
    }
    current = current.parentElement
  }
  return getSourceInfo(el)
}

// ─── inline text editing ──────────────────────────────────────────────────────

const editState = {
  active:       false,
  element:      null as HTMLElement | null,
  originalText: '',
  sourceInfo:   {} as SourceInfo,
  editedTagName: '',
  textContentSample: '',
  hasChildElements: false,
}

function enterEditMode(el: HTMLElement): void {
  if (editState.active) {
    log('enterEditMode: already active — committing previous edit first')
    commitEdit()
  }

  const originalText = el.textContent ?? ''
  log(`enterEditMode: <${el.tagName.toLowerCase()}> text="${originalText.trim().slice(0, 40)}"`)

  editState.active       = true
  editState.element      = el
  editState.originalText = originalText
  editState.sourceInfo   = getClosestSourceInfo(el)
  editState.editedTagName = el.dataset.hbOriginalTag ?? el.tagName.toLowerCase()
  editState.textContentSample = originalText.slice(0, 300)
  editState.hasChildElements = el.dataset.hbOriginalHadChildren === 'true' || el.childElementCount > 0
  log(`[bridge] edit-start source: <${editState.editedTagName}> ${editState.sourceInfo.sourceFile ?? 'NONE'}:${editState.sourceInfo.sourceLine ?? 'NONE'}`)
  log(`[bridge] edit-start textContent(300)="${editState.textContentSample}" childElements=${editState.hasChildElements}`)

  // Clear any inspect outline so only the green edit outline shows
  clearSelected()
  clearHover()

  el.setAttribute('contenteditable', 'true')
  el.setAttribute('data-hb-editing', 'true')
  setOutline(el, EDIT_OUTLINE)
  document.body.style.cursor = 'text'

  // Make sure the element can receive programmatic focus
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
  el.focus()

  log('enterEditMode: element focused — selecting all content')

  // Select all text so the user can immediately type to replace
  try {
    const sel = window.getSelection()
    const r   = document.createRange()
    r.selectNodeContents(el)
    sel?.removeAllRanges()
    sel?.addRange(r)
    log('enterEditMode: selection set')
  } catch (err) {
    log(`enterEditMode: selection failed (non-fatal): ${String(err)}`)
  }

  document.addEventListener('keydown',   onEditKeydown,   true)
  document.addEventListener('mousedown', onEditMousedown, true)
  log('enterEditMode: edit listeners registered ✓')
}

function commitEdit(): void {
  const el = editState.element
  if (!el) return

  const newText = (el.textContent ?? '').trim()
  const oldText = editState.originalText.trim()

  log(`[bridge] save payload oldText="${oldText.slice(0, 300)}" newText="${newText.slice(0, 300)}" editedTagName=${editState.editedTagName} source=${editState.sourceInfo.sourceFile ?? 'NONE'}:${editState.sourceInfo.sourceLine ?? 'NONE'}`)

  cleanupEdit(el)

  if (newText !== oldText) {
    log('commitEdit: text changed — sending editor:text-saved')

    // Collect parent / sibling context so the renderer can rank source matches better
    const parent      = el.parentElement
    const prevSib     = el.previousElementSibling
    const nextSib     = el.nextElementSibling

    const parentText   = parent
      ? (parent.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
      : null
    const siblingBefore = prevSib
      ? (prevSib.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
      : null
    const siblingAfter  = nextSib
      ? (nextSib.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
      : null

    const { sourceFile, sourceLine, sourceCol } = editState.sourceInfo
    log(`[bridge] text-saved payload source info: file=${sourceFile ?? 'NONE'} line=${sourceLine ?? 'NONE'}`)

    ipcRenderer.sendToHost('editor:text-saved', {
      tagName:      el.tagName.toLowerCase(),
      editedTagName: editState.editedTagName,
      editedText:   newText,
      editedTextContentSample: editState.textContentSample,
      editedElementHasChildren: editState.hasChildElements,
      id:           el.id || null,
      classList:    Array.from(el.classList),
      href:         el instanceof HTMLAnchorElement ? el.getAttribute('href') : null,
      oldText,
      newText,
      parentText,
      siblingBefore,
      siblingAfter,
      pathname:     window.location.pathname,
      sourceFile,
      sourceLine,
      sourceCol,
    })
    unwrapTemporaryTextEditor(el)
  } else {
    log('commitEdit: no change')
    unwrapTemporaryTextEditor(el)
  }

  resetEditState()
}

function cancelEdit(): void {
  const el = editState.element
  if (!el) return
  log('cancelEdit: restoring original text')
  el.textContent = editState.originalText
  cleanupEdit(el)
  unwrapTemporaryTextEditor(el)
  resetEditState()
}

function unwrapTemporaryTextEditor(el: HTMLElement): void {
  if (el.dataset.hbTemporaryTextEditor !== 'true') return
  el.replaceWith(document.createTextNode(el.textContent ?? ''))
}

function cleanupEdit(el: HTMLElement): void {
  el.removeAttribute('contenteditable')
  el.removeAttribute('data-hb-editing')
  el.removeAttribute('tabindex')
  setOutline(el, state.selected === el ? SELECT_OUTLINE : '')
  document.body.style.cursor = state.enabled ? 'crosshair' : ''
  document.removeEventListener('keydown',   onEditKeydown,   true)
  document.removeEventListener('mousedown', onEditMousedown, true)
  log('cleanupEdit: edit listeners removed')
}

function resetEditState(): void {
  editState.active       = false
  editState.element      = null
  editState.originalText = ''
  editState.sourceInfo   = {}
  editState.editedTagName = ''
  editState.textContentSample = ''
  editState.hasChildElements = false
}

function onEditKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    log('keydown: Enter — committing')
    e.preventDefault()
    commitEdit()
  } else if (e.key === 'Escape') {
    log('keydown: Escape — cancelling')
    e.preventDefault()
    cancelEdit()
  }
}

function onEditMousedown(e: MouseEvent): void {
  const target = e.target as Node | null
  if (!target) return
  if (editState.element && !editState.element.contains(target)) {
    log('mousedown outside edit element — committing')
    commitEdit()
  }
}

// ─── enable / disable ─────────────────────────────────────────────────────────

function enable(): void {
  if (state.enabled) return
  log('enabled — click/hover listeners attached')
  state.enabled = true
  document.body.style.cursor = 'crosshair'
  document.addEventListener('click',     onClick,     true)
  document.addEventListener('mouseover', onMouseOver, true)
  document.addEventListener('mouseout',  onMouseOut,  true)
}

function disable(): void {
  if (!state.enabled) return
  log('disabled — removing listeners')
  if (editState.active) cancelEdit()
  state.enabled = false
  document.body.style.cursor = ''
  document.removeEventListener('click',     onClick,     true)
  document.removeEventListener('mouseover', onMouseOver, true)
  document.removeEventListener('mouseout',  onMouseOut,  true)
  clearHover()
  clearSelected()
  lastClickMs = 0
  lastClickEl = null
}

// ─── dom patch (Inspector-driven edits) ───────────────────────────────────────

interface DomPatch {
  text?: string
  href?: string
  disabled?: boolean
  imageSrc?: string
  imageAlt?: string
  imageWidth?: string
  imageHeight?: string
  objectFit?: string
  backgroundImage?: string
}

function applyDomPatch(patch: DomPatch): void {
  const el = state.selected
  if (!el) { log('applyDomPatch: no selected element'); return }

  if (patch.text     !== undefined) el.textContent = patch.text
  if (patch.href     !== undefined) (el as HTMLAnchorElement).setAttribute('href', patch.href)
  if (patch.disabled !== undefined) (el as HTMLButtonElement).disabled = patch.disabled

  const img = el as HTMLImageElement
  if (patch.imageSrc !== undefined) img.src = patch.imageSrc
  if (patch.imageAlt !== undefined) img.alt = patch.imageAlt
  if (patch.imageWidth !== undefined) {
    const w = patch.imageWidth.trim()
    if (/^\d+$/.test(w)) img.width = parseInt(w, 10)
    else el.style.width = w
  }
  if (patch.imageHeight !== undefined) {
    const h = patch.imageHeight.trim()
    if (/^\d+$/.test(h)) img.height = parseInt(h, 10)
    else el.style.height = h
  }
  if (patch.objectFit       !== undefined) el.style.objectFit       = patch.objectFit
  if (patch.backgroundImage !== undefined) el.style.backgroundImage = patch.backgroundImage

  log(`applyDomPatch applied to <${el.tagName.toLowerCase()}>`)
  ipcRenderer.sendToHost('inspector:selected', collectData(el))
}

// ─── IPC setup ────────────────────────────────────────────────────────────────

function setup(): void {
  log('setup() — registering IPC listeners')
  ipcRenderer.on('inspector:enable',  () => { log('IPC → inspector:enable');  enable()  })
  ipcRenderer.on('inspector:disable', () => { log('IPC → inspector:disable'); disable() })
  ipcRenderer.on('inspector:clear',   () => { clearHover(); clearSelected() })
  ipcRenderer.on('editor:apply-dom-patch', (_e, patch: DomPatch) => applyDomPatch(patch))
}

if (document.readyState === 'loading') {
  log('DOM not ready — waiting for DOMContentLoaded')
  document.addEventListener('DOMContentLoaded', setup)
} else {
  log('DOM already ready — calling setup() immediately')
  setup()
}
