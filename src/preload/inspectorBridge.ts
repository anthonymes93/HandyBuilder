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

// ─── document generation ───────────────────────────────────────────────────────
// This preload script re-executes from scratch on every real navigation/full
// reload (a fresh JS context — `documentGenerationId` is a new value each
// time), but NOT on a React Fast Refresh HMR patch (same document, same
// script instance, same id). The host uses a change in this id — not
// webview lifecycle events alone — as the authoritative signal that a full
// reload actually happened and it's now safe to restore against the new DOM.

const documentGenerationId =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `gen-${Date.now()}-${Math.random().toString(36).slice(2)}`

// Chromium's own scroll-position memory (bfcache/history-based) restores a
// stale position on reload before our own restore logic ever runs, and can
// fight it. We own scroll restoration entirely — turn the browser's off.
try {
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
} catch { /* ignore — history may not be accessible this early */ }

ipcRenderer.sendToHost('bridge:ready', { documentGenerationId, href: window.location.href })
log(`document generation ${documentGenerationId}`)

// ─── outline constants ────────────────────────────────────────────────────────

const HOVER_OUTLINE   = '2px dashed rgba(59, 130, 246, 0.75)'
const SELECT_OUTLINE  = '2px solid rgb(59, 130, 246)'
const EDIT_OUTLINE    = '2px solid rgb(34, 197, 94)'
/** Temporary outline shown while hovering a nested-element candidate in the delete submenu — distinct colour from selection/hover so it reads as "preview, not committed". */
const PREVIEW_OUTLINE = '2px dashed rgb(245, 158, 11)'

// ─── inspect state ────────────────────────────────────────────────────────────

const state = {
  enabled:  false,
  hovered:  null as HTMLElement | null,
  selected: null as HTMLElement | null,
  // Tracks which inline style properties the visual style editors last applied
  // to the selected element, so switching Normal ↔ Hover (or Cancel) can cleanly
  // clear properties that are no longer part of the current draft.
  lastAppliedStyleProps: new Set<string>(),
  // The resolved visual background-image owner for the current selection, when
  // it is a real DOM node (img-tag / inline-style-url / css-class-url /
  // tailwind-arbitrary-url) — pseudo-element owners have no DOM node to patch.
  // Image-related DomPatch fields target this element instead of `selected`.
  imageOwnerEl: null as HTMLElement | null,
  // Client coordinates of the last click — reused by collectData() when it's
  // re-invoked without a fresh click (e.g. after an applyDomPatch echo).
  lastClickPoint: null as { x: number; y: number } | null,
  // Nested-element deletion candidates from the most recent right-click/
  // Delete-key request — short-lived, valid only until the next selection.
  // Lets the host ask to preview/select one by id without re-resolving it.
  deletionCandidateEls: new Map<string, HTMLElement>(),
  previewOutlineEl: null as HTMLElement | null,
  // The RAW deepest DOM node under the cursor for the most recent right-click
  // — captured before resolveSelectTarget() runs, so a click on a nested icon
  // never loses its own identity to the smart-promoted edit selection. This
  // (not `selected`, which may already be the promoted ancestor) is what
  // deletion candidate-building must start from.
  lastContextMenuElement: null as HTMLElement | null,
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
  state.imageOwnerEl = null
}

// ─── background-image owner resolution ───────────────────────────────────────
// A click often lands on a decorative layer (a translucent overlay div, an
// empty absolutely-positioned content wrapper) sitting in front of the real
// image. Rather than trust the clicked element's own computed background, we
// scan the FULL paint z-stack at the click point (elementsFromPoint returns
// every element whose box covers that pixel, topmost first, regardless of
// what visually obscures it) plus the clicked element's ancestor chain, and
// resolve the nearest candidate that actually owns an image.

export type ImageOwnerSourceType =
  | 'img-tag' | 'inline-style-url' | 'css-class-url' | 'tailwind-arbitrary-url'
  | 'pseudo-before' | 'pseudo-after'

interface ImageOwnerResult {
  /** The real DOM node responsible — null only for pseudo-element owners. */
  el: HTMLElement
  pseudo: '::before' | '::after' | null
  sourceType: ImageOwnerSourceType
  backgroundUrl: string
  cssSelector: string | null
  cssSourceFile: string | null
  resolutionPath: string
  isSelectedElement: boolean
}

function extractUrl(bg: string): string | null {
  const m = bg.match(/url\(["']?([^"')]+)["']?\)/)
  return m ? m[1] : null
}

function hasUrlComponent(bg: string): boolean {
  return /url\(/.test(bg)
}

function isPureGradient(bg: string): boolean {
  return /-gradient\(/.test(bg) && !hasUrlComponent(bg)
}

function describeEl(el: HTMLElement): string {
  const tag = el.tagName.toLowerCase()
  const cls = el.classList[0] ? `.${el.classList[0]}` : ''
  return `${tag}${cls}`
}

function findTailwindBgUrlToken(el: HTMLElement): string | null {
  for (const c of Array.from(el.classList)) {
    if (/^bg-\[url\(.+\)\]$/.test(c)) return c
  }
  return null
}

/**
 * Find the CSSOM rule responsible for an element's (or its ::before/::after's)
 * background-image, by matching each accessible stylesheet rule's base
 * selector against the element. The rule's owning <style> tag's
 * data-vite-dev-id (set by Vite's dev-time CSS injection) recovers the
 * absolute source file path with no custom plugin required.
 */
function findCssBackgroundRule(
  el: HTMLElement,
  pseudo: '::before' | '::after' | null
): { selectorText: string; url: string; sourceFile: string | null } | null {
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue // cross-origin stylesheet — inaccessible
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule)) continue
      const selectorText = rule.selectorText
      if (!selectorText) continue
      const bg = rule.style.backgroundImage
      if (!bg || !hasUrlComponent(bg)) continue

      const selHasPseudo = /::?(before|after)\s*$/.test(selectorText)
      if ((pseudo !== null) !== selHasPseudo) continue
      if (pseudo) {
        const suffix = pseudo === '::before' ? /::?before\s*$/ : /::?after\s*$/
        if (!suffix.test(selectorText)) continue
      }

      const baseSelector = selectorText.replace(/::?(before|after)\s*$/, '').trim()
      try {
        if (!baseSelector || !el.matches(baseSelector)) continue
      } catch {
        continue // selector syntax CSSOM accepted but matches() doesn't (rare)
      }

      const ownerNode = sheet.ownerNode as (Element & { dataset?: DOMStringMap }) | null
      const sourceFile = ownerNode?.dataset?.viteDevId ?? null
      return { selectorText, url: extractUrl(bg) ?? '', sourceFile }
    }
  }
  return null
}

function resolveImageOwner(x: number, y: number, clicked: HTMLElement): ImageOwnerResult | null {
  const stack = (document.elementsFromPoint(x, y) as Element[]).filter(
    (n): n is HTMLElement => n instanceof HTMLElement
  )

  const ancestors: HTMLElement[] = []
  {
    const BOUNDARY = new Set(['SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'BODY'])
    let node: HTMLElement | null = clicked
    let depth = 0
    while (node && depth < 8) {
      ancestors.push(node)
      if (BOUNDARY.has(node.tagName)) break
      node = node.parentElement
      depth++
    }
  }

  const seen = new Set<HTMLElement>()
  const candidates: HTMLElement[] = []
  for (const el of [...stack, ...ancestors]) {
    if (seen.has(el)) continue
    seen.add(el)
    candidates.push(el)
  }

  for (const el of candidates) {
    // (a) explicit <img> / <picture><img>
    if (el.tagName === 'IMG' || el.tagName === 'PICTURE') {
      const img = el.tagName === 'IMG' ? (el as HTMLImageElement) : el.querySelector('img')
      if (img) {
        return {
          el: img,
          pseudo: null,
          sourceType: 'img-tag',
          backgroundUrl: img.getAttribute('src') ?? '',
          cssSelector: null,
          cssSourceFile: null,
          resolutionPath: img === clicked ? 'direct' : `${describeEl(clicked)} → ${describeEl(img)}`,
          isSelectedElement: img === clicked,
        }
      }
    }

    // (b) ::before / ::after pseudo-elements
    for (const pseudo of ['::before', '::after'] as const) {
      const pseudoBg = window.getComputedStyle(el, pseudo).backgroundImage
      if (pseudoBg && hasUrlComponent(pseudoBg)) {
        const rule = findCssBackgroundRule(el, pseudo)
        return {
          el,
          pseudo,
          sourceType: pseudo === '::before' ? 'pseudo-before' : 'pseudo-after',
          backgroundUrl: rule?.url ?? extractUrl(pseudoBg) ?? '',
          cssSelector: rule?.selectorText ?? null,
          cssSourceFile: rule?.sourceFile ?? null,
          resolutionPath: `${describeEl(clicked)} → ${describeEl(el)}${pseudo}`,
          isSelectedElement: false, // pseudo-elements are never the clicked DOM node
        }
      }
    }

    // (c) own computed background-image with a genuine url() component
    //     (pure CSS gradients — e.g. Tailwind's bg-gradient-to-r overlays —
    //     are deliberately NOT treated as an image owner here).
    const bg = window.getComputedStyle(el).backgroundImage
    if (bg && hasUrlComponent(bg)) {
      const tw = findTailwindBgUrlToken(el)
      const inlineHasUrl = hasUrlComponent(el.style.backgroundImage || '')
      const sourceType: ImageOwnerSourceType = inlineHasUrl
        ? 'inline-style-url'
        : tw
          ? 'tailwind-arbitrary-url'
          : 'css-class-url'
      const cssRule = sourceType === 'css-class-url' ? findCssBackgroundRule(el, null) : null
      return {
        el,
        pseudo: null,
        sourceType,
        backgroundUrl: extractUrl(bg) ?? '',
        cssSelector: cssRule?.selectorText ?? null,
        cssSourceFile: cssRule?.sourceFile ?? null,
        resolutionPath: el === clicked ? 'direct' : `${describeEl(clicked)} → ${describeEl(el)}`,
        isSelectedElement: el === clicked,
      }
    }
  }

  return null
}

/** Paint info for the overlay layer (the clicked element itself) when a different owner was resolved. */
function resolveOverlayInfo(clicked: HTMLElement, owner: ImageOwnerResult | null): { backgroundColor: string; gradient: string | null; opacity: string } | null {
  if (!owner || owner.isSelectedElement) return null
  const cs = window.getComputedStyle(clicked)
  return {
    backgroundColor: cs.backgroundColor,
    gradient: isPureGradient(cs.backgroundImage) ? cs.backgroundImage : null,
    opacity: cs.opacity,
  }
}

function collectData(el: HTMLElement, resolvedFrom?: string | null, clickPoint?: { x: number; y: number }) {
  const rect = el.getBoundingClientRect()
  const cs   = window.getComputedStyle(el)
  const a    = el as HTMLAnchorElement
  const inp  = el as HTMLInputElement
  const btn  = el as HTMLButtonElement
  const img  = el as HTMLImageElement

  const isImg = el.tagName === 'IMG'

  const {
    sourceFile, sourceLine, sourceCol, sourceEndLine, sourceEndCol, sourceTag, componentName, origin,
  } = getClosestSourceInfo(el)
  log(
    `[bridge] selected source info: file=${sourceFile ?? 'NONE'} line=${sourceLine ?? 'NONE'} ` +
    `col=${sourceCol ?? 'NONE'} tag=${sourceTag ?? 'NONE'} component=${componentName ?? 'NONE'} origin=${origin ?? 'NONE'}`
  )

  // ── background-image owner resolution ───────────────────────────────────
  const point = clickPoint ?? state.lastClickPoint ?? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  const ownerResult = resolveImageOwner(point.x, point.y, el)
  state.imageOwnerEl = ownerResult && !ownerResult.pseudo ? ownerResult.el : null

  const usesCssFile = !!ownerResult && (!!ownerResult.pseudo || ownerResult.sourceType === 'css-class-url')
  const jsxOwnerSource = ownerResult && !usesCssFile ? getClosestSourceInfo(ownerResult.el) : null

  const imageOwnerPayload = ownerResult ? {
    tagName: ownerResult.el.tagName.toLowerCase(),
    sourceFile: usesCssFile ? (ownerResult.cssSourceFile ?? null) : (jsxOwnerSource?.sourceFile ?? null),
    sourceLine: usesCssFile ? null : (jsxOwnerSource?.sourceLine ?? null),
    sourceCol: usesCssFile ? null : (jsxOwnerSource?.sourceCol ?? null),
    sourceTag: jsxOwnerSource?.sourceTag ?? null,
    componentName: jsxOwnerSource?.componentName ?? null,
    origin: jsxOwnerSource?.origin ?? null,
    sourceType: ownerResult.sourceType,
    backgroundUrl: ownerResult.backgroundUrl,
    cssSelector: ownerResult.cssSelector,
    resolutionPath: ownerResult.resolutionPath,
    isSelectedElement: ownerResult.isSelectedElement,
  } : null

  if (ownerResult) {
    log(
      `[bridge] image owner resolved: <${imageOwnerPayload!.tagName}> type=${ownerResult.sourceType} ` +
      `path="${ownerResult.resolutionPath}" file=${imageOwnerPayload!.sourceFile ?? 'NONE'} url=${ownerResult.backgroundUrl}`
    )
  }

  const overlayPayload = resolveOverlayInfo(el, ownerResult)

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
      objectPosition: cs.objectPosition,
      backgroundImage: cs.backgroundImage,
      backgroundSize: cs.backgroundSize,
      backgroundPosition: cs.backgroundPosition,
      transform: cs.transform,
      fontFamily: cs.fontFamily,
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      textAlign: cs.textAlign,
      textTransform: cs.textTransform,
      textDecorationLine: cs.textDecorationLine,
      borderTopWidth: cs.borderTopWidth,
      borderStyle: cs.borderTopStyle,
      borderColor: cs.borderTopColor,
      borderTopLeftRadius: cs.borderTopLeftRadius,
      borderTopRightRadius: cs.borderTopRightRadius,
      borderBottomRightRadius: cs.borderBottomRightRadius,
      borderBottomLeftRadius: cs.borderBottomLeftRadius,
      width: cs.width,
      minWidth: cs.minWidth,
      height: cs.height,
      display: cs.display,
      justifyContent: cs.justifyContent,
      alignItems: cs.alignItems,
      opacity: cs.opacity,
      boxShadow: cs.boxShadow,
      transitionDuration: cs.transitionDuration,
    },
    href:      'href'      in el ? (a.getAttribute('href') ?? null) : null,
    linkTarget: el.tagName === 'A' ? (a.getAttribute('target') ?? null) : null,
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
    hbSourceEndLine: sourceEndLine ?? null,
    hbSourceEndCol:  sourceEndCol  ?? null,
    hbSourceTag:     sourceTag     ?? null,
    hbSourceOrigin:  origin        ?? null,
    hbComponentName: componentName ?? null,
    // Per-item identifier for mapped array elements (set via data-hb-item-id attribute)
    hbItemId: el.getAttribute('data-hb-item-id') ?? null,
    // Set when the clicked element was resolved up to a closer ancestor (e.g. div → a)
    resolvedFrom: resolvedFrom ?? null,
    // Stable per-element style class, once a style has been saved for this element
    // (hb-style-* for shared-component/direct edits, hb-instance-* for per-instance edits).
    hbStyleId: Array.from(el.classList).find((c) => /^hb-(style|instance)-[a-z0-9]+$/.test(c))?.replace(/^hb-(style|instance)-/, '') ?? null,
    // Current route — folded into the style-identity hash so mapped/repeated
    // instances on different routes never collide.
    pathname: window.location.pathname,
    // Resolved visual background-image owner (may differ from this element —
    // e.g. this element is a translucent overlay in front of the real image).
    imageOwner: imageOwnerPayload,
    // The overlay layer's own paint info, present only when imageOwner exists
    // and isn't this element itself.
    overlay: overlayPayload,
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

// ─── selection priority resolver ─────────────────────────────────────────────
// Text / content tags inside a link are independently selectable so the user
// can still double-click to edit them inline.  Everything else (icon divs,
// SVGs, spacers) defers to the wrapping anchor.
const CONTENT_TAGS_IN_LINKS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'li', 'dt', 'dd',
])

interface Resolved { el: HTMLElement; reason: string; resolvedFrom: string | null }

function resolveSelectTarget(target: HTMLElement): Resolved {
  // Walk from target toward the nearest <a>, looking for image-like content first.
  // We stop climbing as soon as we hit an element that should be the selection.
  let node: HTMLElement | null = target
  while (node) {
    const tag = node.tagName
    // Explicit image elements always win.
    if (tag === 'IMG' || tag === 'PICTURE') {
      return { el: node, reason: 'image-direct', resolvedFrom: null }
    }
    // An element with a real url()-based CSS background-image wins over any
    // ancestor link. A pure CSS gradient (e.g. Tailwind's bg-gradient-to-r,
    // commonly used for decorative overlays) does NOT count here — it isn't
    // "the image" the user is looking at, and must not hijack selection
    // priority away from a wrapping link or a sibling/ancestor real image.
    const bg = window.getComputedStyle(node).backgroundImage
    if (hasUrlComponent(bg)) {
      return { el: node, reason: 'background-image', resolvedFrom: null }
    }
    // Reached an anchor boundary — stop the image scan here.
    if (tag === 'A') break
    node = node.parentElement
  }

  // No image found between target and <a>. Now decide link vs. content element.
  const anchor = node && node.tagName === 'A' ? node as HTMLElement : null

  if (anchor) {
    if (target === anchor) return { el: anchor, reason: 'link-direct', resolvedFrom: null }
    const targetTag = target.tagName.toLowerCase()
    // Headings / paragraphs stay independently selectable for inline text editing.
    if (CONTENT_TAGS_IN_LINKS.has(targetTag)) {
      return { el: target, reason: 'container', resolvedFrom: null }
    }
    // Everything else (Visit Site div, icon SVG, spacer…) → anchor.
    return { el: anchor, reason: 'link-closest', resolvedFrom: targetTag }
  }

  return { el: target, reason: 'container', resolvedFrom: null }
}

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
  state.lastClickPoint = { x: e.clientX, y: e.clientY }

  const { el: resolved, reason, resolvedFrom } = resolveSelectTarget(target)

  log(`click on <${target.tagName.toLowerCase()}> → <${resolved.tagName.toLowerCase()}> [${reason}]`)
  clearSelected()
  state.lastAppliedStyleProps.clear()
  state.selected = resolved
  setOutline(resolved, SELECT_OUTLINE)
  if (state.hovered === resolved) state.hovered = null
  ipcRenderer.sendToHost('inspector:selected', collectData(resolved, resolvedFrom, state.lastClickPoint))
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
  sourceEndLine?:  number
  sourceEndCol?:   number
  /** The literal JSX tag authored at this exact source position, e.g. "a" or "Button". */
  sourceTag?:      string
  componentName?:  string
  /** Where this metadata came from — surfaced to the user on save failures. */
  origin?:         'direct' | 'parent' | 'fiber'
}

/** Read the data-hb-* attribute set directly off one element. Null if unstamped. */
function readHbAttrs(el: HTMLElement): Omit<SourceInfo, 'origin' | 'componentName'> | null {
  const file = el.getAttribute('data-hb-file')
  if (!file) return null
  const num = (name: string): number | undefined => {
    const v = el.getAttribute(name)
    return v ? parseInt(v, 10) : undefined
  }
  return {
    sourceFile: file,
    sourceLine: num('data-hb-line'),
    sourceCol: num('data-hb-col'),
    sourceEndLine: num('data-hb-end-line'),
    sourceEndCol: num('data-hb-end-col'),
    sourceTag: el.getAttribute('data-hb-tag') || undefined,
  }
}

/**
 * Fall back to React fiber _debugSource. @vitejs/plugin-react in dev mode asks
 * Babel to include __source info on every JSX element; React stores it on
 * fiber._debugSource = {fileName, lineNumber, columnNumber}.
 */
function getFiberSourceInfo(el: HTMLElement): SourceInfo {
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
        return { sourceFile: src.fileName, sourceLine: src.lineNumber, sourceCol: src.columnNumber, componentName, origin: 'fiber' }
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

/**
 * Direct data-hb-* on `el`, else the NEAREST DOM ancestor's data-hb-* (marked
 * origin: 'parent' so callers know the position may describe an ancestor's
 * JSX, not the clicked element's own), else the fiber fallback.
 */
function getClosestSourceInfo(el: HTMLElement): SourceInfo {
  const direct = readHbAttrs(el)
  if (direct) return { ...direct, origin: 'direct' }

  let current = el.parentElement
  while (current) {
    const parentAttrs = readHbAttrs(current)
    if (parentAttrs) {
      log(`[bridge] source via data-hb-* (parent): ${parentAttrs.sourceFile}:${parentAttrs.sourceLine} tag=${parentAttrs.sourceTag ?? '?'}`)
      return { ...parentAttrs, origin: 'parent' }
    }
    current = current.parentElement
  }
  return getFiberSourceInfo(el)
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

    // Walk up the DOM to find the nearest data-hb-item-id (for mapped array cards).
    let hbItemId: string | null = null
    {
      let node: HTMLElement | null = el
      while (node) {
        const id = node.getAttribute('data-hb-item-id')
        if (id) { hbItemId = id; break }
        node = node.parentElement
      }
    }
    if (hbItemId) log(`[bridge] text-saved hbItemId="${hbItemId}"`)

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
      hbItemId,
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
  document.addEventListener('click',       onClick,       true)
  document.addEventListener('mouseover',   onMouseOver,   true)
  document.addEventListener('mouseout',    onMouseOut,    true)
  document.addEventListener('contextmenu', onContextMenu, true)
  document.addEventListener('keydown',     onDeleteKeyDown, true)
}

function disable(): void {
  if (!state.enabled) return
  log('disabled — removing listeners')
  if (editState.active) cancelEdit()
  state.enabled = false
  document.body.style.cursor = ''
  document.removeEventListener('click',       onClick,       true)
  document.removeEventListener('mouseover',   onMouseOver,   true)
  document.removeEventListener('mouseout',    onMouseOut,    true)
  document.removeEventListener('contextmenu', onContextMenu, true)
  document.removeEventListener('keydown',     onDeleteKeyDown, true)
  clearHover()
  clearSelected()
  lastClickMs = 0
  lastClickEl = null
}

// ─── dom patch (Inspector-driven edits) ───────────────────────────────────────

interface DomPatch {
  text?: string
  href?: string
  linkTarget?: string
  disabled?: boolean
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
  styleProps?: Record<string, string>
  clearStyleProps?: true
}

function applyDomPatch(patch: DomPatch): void {
  const el = state.selected
  if (!el) { log('applyDomPatch: no selected element'); return }

  if (patch.text     !== undefined) el.textContent = patch.text
  if (patch.href     !== undefined) (el as HTMLAnchorElement).setAttribute('href', patch.href)
  if (patch.linkTarget !== undefined) {
    if (patch.linkTarget) el.setAttribute('target', patch.linkTarget)
    else el.removeAttribute('target')
  }
  if (patch.disabled !== undefined) (el as HTMLButtonElement).disabled = patch.disabled

  // Image-related fields target the resolved background-image OWNER, which
  // may be a different element than the selected/clicked one (e.g. selected
  // is a translucent overlay div sitting in front of the real <img> or
  // background-image element behind it). Falls back to `el` for the common
  // case where the clicked element IS the owner (a plain <img> or bg-div).
  const imgTarget = (state.imageOwnerEl ?? el) as HTMLImageElement
  if (patch.imageSrc !== undefined) imgTarget.src = patch.imageSrc
  if (patch.imageAlt !== undefined) imgTarget.alt = patch.imageAlt
  if (patch.imageWidth !== undefined) {
    const w = patch.imageWidth.trim()
    if (/^\d+$/.test(w)) imgTarget.width = parseInt(w, 10)
    else imgTarget.style.width = w
  }
  if (patch.imageHeight !== undefined) {
    const h = patch.imageHeight.trim()
    if (/^\d+$/.test(h)) imgTarget.height = parseInt(h, 10)
    else imgTarget.style.height = h
  }
  if (patch.objectFit        !== undefined) imgTarget.style.objectFit        = patch.objectFit
  if (patch.objectPosition   !== undefined) imgTarget.style.objectPosition   = patch.objectPosition
  if (patch.backgroundImage  !== undefined) imgTarget.style.backgroundImage  = patch.backgroundImage
  if (patch.backgroundSize   !== undefined) imgTarget.style.backgroundSize   = patch.backgroundSize
  if (patch.backgroundPosition !== undefined) imgTarget.style.backgroundPosition = patch.backgroundPosition
  if (patch.transform        !== undefined) imgTarget.style.transform        = patch.transform

  // Generic resolved style bag from the visual Button/Text style editors — one
  // full snapshot per change. Clear any previously-applied key that's no longer
  // present (e.g. switching Hover → Normal drops hover-only properties).
  if (patch.clearStyleProps) {
    for (const prop of state.lastAppliedStyleProps) {
      (el.style as unknown as Record<string, string>)[prop] = ''
    }
    state.lastAppliedStyleProps.clear()
  }
  if (patch.styleProps) {
    const nextKeys = new Set(Object.keys(patch.styleProps))
    for (const prop of state.lastAppliedStyleProps) {
      if (!nextKeys.has(prop)) (el.style as unknown as Record<string, string>)[prop] = ''
    }
    for (const [prop, value] of Object.entries(patch.styleProps)) {
      (el.style as unknown as Record<string, string>)[prop] = value
    }
    state.lastAppliedStyleProps = nextKeys
  }

  log(`applyDomPatch applied to <${el.tagName.toLowerCase()}>`)
  ipcRenderer.sendToHost('inspector:selected', collectData(el))
}

// ─── SPA route detection ──────────────────────────────────────────────────────

function onRouteChange(): void {
  log(`route changed → ${window.location.pathname}`)
  if (editState.active) cancelEdit()
  clearHover()
  clearSelected()
  ipcRenderer.sendToHost('inspector:route-changed', {
    pathname: window.location.pathname,
    href:     window.location.href,
  })
}

function patchHistory(): void {
  const origPush    = history.pushState.bind(history) as typeof history.pushState
  const origReplace = history.replaceState.bind(history) as typeof history.replaceState

  history.pushState = function (data, unused, url) {
    origPush(data, unused, url)
    onRouteChange()
  }
  history.replaceState = function (data, unused, url) {
    origReplace(data, unused, url)
    onRouteChange()
  }

  window.addEventListener('popstate',   onRouteChange)
  window.addEventListener('hashchange', onRouteChange)
  log('history patched for SPA route detection')
}

// ─── preview view-state capture / restore ─────────────────────────────────────
// Save/Undo/Redo write a source file, which Vite's dev server picks up — often
// as a genuine full-page reload (this preload script re-runs from scratch,
// `state` resets) rather than a silent HMR patch. The host asks us to capture
// scroll/selection just before writing, then repeatedly asks us to restore it
// afterward (see PreviewPanel.tsx's retry loop) until it sticks or times out.

interface CapturedViewState {
  href: string
  pathname: string
  scrollX: number
  scrollY: number
  documentHeight: number
  viewportHeight: number
  /** Selected element's distance from the viewport top at capture time, so restore can reproduce its on-screen position (not just re-center it). */
  elementViewportOffsetY: number | null
  /** This document's generation id — the host stores it to detect a later full reload (a different id) vs. Fast Refresh (same id). */
  documentGenerationId: string
}

function captureViewState(): CapturedViewState {
  return {
    href: window.location.href,
    pathname: window.location.pathname,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    documentHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
    elementViewportOffsetY: state.selected ? state.selected.getBoundingClientRect().top : null,
    documentGenerationId,
  }
}

interface ElementIdentity {
  hbStyleId?: string | null
  sourceFile?: string | null
  sourceLine?: number | null
  sourceCol?: number | null
  hbItemId?: string | null
  id?: string | null
  tagName?: string | null
  classList?: string[]
  textPreview?: string | null
  href?: string | null
}

/** Priority 1 — the stable per-element class attached once a style has been saved for it. */
function findByStyleId(id: string): HTMLElement | null {
  const els = document.querySelectorAll<HTMLElement>('[class]')
  for (const el of els) {
    if (Array.from(el.classList).some((c) => c === `hb-style-${id}` || c === `hb-instance-${id}`)) return el
  }
  return null
}

/** Priority 2 — exact data-hb-file/line, with data-hb-col as a tiebreaker among same-line matches. */
function findBySource(file: string, line: number, col?: number | null): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('[data-hb-file]')).filter(
    (el) => el.getAttribute('data-hb-file') === file && Number(el.getAttribute('data-hb-line')) === line
  )
  if (candidates.length === 0) return null
  if (candidates.length === 1 || col == null) return candidates[0]
  return candidates.reduce((best, el) => {
    const c  = Number(el.getAttribute('data-hb-col'))
    const bc = Number(best.getAttribute('data-hb-col'))
    return Math.abs(c - col) < Math.abs(bc - col) ? el : best
  })
}

/** Priority 3 — mapped-array card identifier. */
function findByItemId(itemId: string): HTMLElement | null {
  try {
    return document.querySelector<HTMLElement>(`[data-hb-item-id="${CSS.escape(itemId)}"]`)
  } catch {
    return null
  }
}

/** Priority 5 — anchor matched by href + trimmed text content. */
function findByHrefText(href: string, text: string): HTMLElement | null {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ')
  const wanted = norm(text)
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
  return anchors.find((a) => a.getAttribute('href') === href && norm(a.textContent ?? '') === wanted) ?? null
}

/** Priority 6 — best-effort: same tag, scored by class overlap + exact text match. */
function findByTagClassText(tagName: string, classList: string[], textPreview: string): HTMLElement | null {
  const candidates = Array.from(document.getElementsByTagName(tagName)) as HTMLElement[]
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').slice(0, 150)
  const wanted = norm(textPreview)
  let best: HTMLElement | null = null
  let bestScore = 0
  for (const el of candidates) {
    const classes = el.classList
    const overlap = classList.filter((c) => classes.contains(c)).length
    const textMatch = wanted && norm(el.textContent ?? '') === wanted ? 5 : 0
    const score = overlap + textMatch
    if (score > bestScore) { bestScore = score; best = el }
  }
  return best
}

function findElementByIdentity(identity: ElementIdentity): { el: HTMLElement; method: string } | null {
  if (identity.hbStyleId) {
    const el = findByStyleId(identity.hbStyleId)
    if (el) return { el, method: 'style-id' }
  }
  if (identity.sourceFile && identity.sourceLine != null) {
    const el = findBySource(identity.sourceFile, identity.sourceLine, identity.sourceCol)
    if (el) return { el, method: 'source' }
  }
  if (identity.hbItemId) {
    const el = findByItemId(identity.hbItemId)
    if (el) return { el, method: 'item-id' }
  }
  if (identity.id) {
    const el = document.getElementById(identity.id)
    if (el) return { el, method: 'id' }
  }
  if (identity.href && identity.textPreview) {
    const el = findByHrefText(identity.href, identity.textPreview)
    if (el) return { el, method: 'href-text' }
  }
  if (identity.tagName && identity.textPreview) {
    const el = findByTagClassText(identity.tagName, identity.classList ?? [], identity.textPreview)
    if (el) return { el, method: 'tag-class-text' }
  }
  return null
}

interface RestoreViewStateParams {
  pathname: string
  scrollX: number
  scrollY: number
  documentHeight: number
  viewportHeight: number
  elementViewportOffsetY: number | null
  identity: ElementIdentity | null
}

function restoreViewState(target: RestoreViewStateParams): void {
  // The document must actually be parsed before scrollIntoView/scroll math
  // means anything — a request that arrives while still `loading` would
  // silently "succeed" against a near-empty page. Tell the host to retry
  // rather than reporting a false positive.
  if (document.readyState === 'loading') {
    log('[bridge] restoreViewState → document still loading, asking host to retry')
    ipcRenderer.sendToHost('inspector:view-restored', {
      success: false, method: 'not-ready', scrollY: window.scrollY, elementFound: false, documentGenerationId,
    })
    return
  }

  let method = 'none'
  let elementFound = false
  let restored = false

  if (target.identity) {
    const match = findElementByIdentity(target.identity)
    if (match) {
      const { el } = match
      method = match.method
      elementFound = true
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
      if (target.elementViewportOffsetY != null) {
        const delta = el.getBoundingClientRect().top - target.elementViewportOffsetY
        if (Math.abs(delta) > 1) window.scrollBy(0, delta)
      }
      // Re-establish bridge selection state so subsequent live-patch edits
      // (drag focal point, colour pickers, …) keep targeting the right node.
      clearSelected()
      state.selected = el
      setOutline(el, SELECT_OUTLINE)
      if (state.hovered === el) state.hovered = null
      ipcRenderer.sendToHost('inspector:selected', collectData(el))
      restored = true
    }
  }

  if (!restored) {
    // No identity, or the element genuinely isn't there anymore — fall back
    // to absolute scroll position, else a proportional ratio (page length
    // may have changed slightly, e.g. late-loading images).
    const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
    if (target.scrollY <= maxScroll + 4) {
      window.scrollTo(target.scrollX, target.scrollY)
      method = 'scroll-absolute'
    } else {
      const ratio = target.scrollY / Math.max(1, target.documentHeight - target.viewportHeight)
      window.scrollTo(target.scrollX, Math.round(ratio * maxScroll))
      method = 'scroll-ratio'
    }
    restored = Math.abs(window.scrollY - Math.min(target.scrollY, maxScroll)) < 40
  }

  log(`[bridge] restoreViewState → method=${method} elementFound=${elementFound} restored=${restored} scrollY=${window.scrollY} gen=${documentGenerationId}`)
  ipcRenderer.sendToHost('inspector:view-restored', {
    success: restored, method, scrollY: window.scrollY, elementFound, documentGenerationId,
  })
}

// ─── element deletion — right-click context menu + Delete/Backspace ──────────

export interface DeletionTargetPayload {
  directFile: string | null
  directLine: number | null
  directCol: number | null
  directTag: string | null
  /**
   * The nearest ANCESTOR composite-component's own invocation site (e.g. for
   * a click landing on <ServiceCard>'s internal root <div>, this is where
   * `<ServiceCard ... />` itself is written) — resolved via the React fiber
   * tree, not data-hb-* attributes, since those never cross a non-prop-
   * forwarding component boundary. Used by the writer to redirect deletion
   * away from a shared component's own definition file.
   */
  ownerFile: string | null
  ownerLine: number | null
  ownerCol: number | null
  ownerComponentName: string | null
  /** Walked up from the clicked element — set only if the project's own JSX authors this attribute. */
  hbItemId: string | null
  /** 0-based position among all elements sharing the exact same direct file+line — the DOM-order fallback for identifying a mapped item when hbItemId isn't available. */
  mappedIndex: number | null
  mappedSiblingCount: number | null
  isProtected: boolean
  protectedReason: string | null
  displayLabel: string
  displaySource: string
  /** Short labels for the deleted element's DOM siblings — what visibly stays behind. Empty when unknown/no DOM anchor. */
  remainingSiblingLabels: string[]
  /** Short label for the deleted element's DOM parent, when it's a real containing element (not <body>). */
  remainingContainerLabel: string | null
}

interface OwnerInvocationInfo {
  file: string | null
  line: number | null
  col: number | null
  componentName: string | null
}

/**
 * Walk the React fiber `.return` chain from `el` to find the nearest
 * ANCESTOR composite-component fiber. A composite fiber's OWN `_debugSource`
 * is where THAT component was invoked as JSX (e.g. `<ServiceCard />` in
 * Services.tsx) — fundamentally different from `el`'s own `_debugSource`,
 * which is wherever `el`'s tag is textually authored (possibly deep inside
 * ServiceCard's own definition file). This is what lets deletion correctly
 * target a reusable component's usage site instead of its shared definition.
 */
function getOwnerInvocationInfo(el: HTMLElement): OwnerInvocationInfo {
  const none: OwnerInvocationInfo = { file: null, line: null, col: null, componentName: null }
  try {
    const fiberKey = Object.keys(el).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
    )
    if (!fiberKey) return none
    let fiber = (el as unknown as Record<string, unknown>)[fiberKey] as Record<string, unknown> | null
    let depth = 0
    while (fiber && depth < 40) {
      if (typeof fiber.type === 'function') {
        const src = fiber._debugSource as { fileName?: string; lineNumber?: number; columnNumber?: number } | undefined
        if (src?.fileName) {
          const named = fiber.type as { displayName?: string; name?: string }
          return {
            file: src.fileName,
            line: src.lineNumber ?? null,
            col: src.columnNumber ?? null,
            componentName: named.displayName ?? named.name ?? null,
          }
        }
      }
      fiber = fiber.return as Record<string, unknown> | null
      depth++
    }
  } catch { /* ignore — fiber internals are not a stable API */ }
  return none
}

/** 0-based position of `el` among all elements sharing the same data-hb-file + data-hb-line, in document order. */
function getMappedIndexInfo(el: HTMLElement, file: string | null, line: number | null): { index: number | null; siblingCount: number | null } {
  if (!file || line == null) return { index: null, siblingCount: null }
  const all = Array.from(document.querySelectorAll<HTMLElement>('[data-hb-file][data-hb-line]')).filter(
    (n) => n.getAttribute('data-hb-file') === file && n.getAttribute('data-hb-line') === String(line)
  )
  const index = all.indexOf(el)
  return { index: index === -1 ? null : index, siblingCount: all.length }
}

function isProtectedElement(el: HTMLElement): { protected: boolean; reason: string | null } {
  const tag = el.tagName
  if (tag === 'HTML' || tag === 'HEAD' || tag === 'BODY') {
    return { protected: true, reason: 'This structural element cannot be deleted safely.' }
  }
  // The React mount container (commonly #root, but fall back to "body's only
  // child with no HandyBuilder source stamp at all" for other mount ids).
  const mount = document.getElementById('root') || document.getElementById('app')
  if (el === mount || (el.parentElement === document.body && !el.hasAttribute('data-hb-file') && !el.closest('[data-hb-file]'))) {
    return { protected: true, reason: 'This structural element cannot be deleted safely.' }
  }
  return { protected: false, reason: null }
}

/** Short human-readable description of `el` for "what remains" messaging — not a source label, just enough to recognise it in the confirm dialog. */
function describeShort(el: HTMLElement): string {
  const tag = el.tagName.toLowerCase()
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 32)
  if (tag === 'a') return text ? `"${text}" link` : 'link'
  if (text) return `"${text}"`
  return `<${tag}>`
}

/**
 * What visibly stays behind if `el` were deleted right now — its DOM
 * siblings (up to 4) and its immediate containing element, purely for the
 * confirm dialog's "what remains" copy. Best-effort: returns empty/null when
 * `el` has no parent (already detached) rather than guessing.
 */
function buildRemainsSummary(el: HTMLElement): { siblings: string[]; container: string | null } {
  const parent = el.parentElement
  if (!parent) return { siblings: [], container: null }
  const siblings = Array.from(parent.children)
    .filter((c): c is HTMLElement => c !== el && c instanceof HTMLElement)
    .slice(0, 4)
    .map(describeShort)
  const container = parent !== document.body ? describeShort(parent) : null
  return { siblings, container }
}

function buildDeletionTarget(el: HTMLElement): DeletionTargetPayload {
  const direct = getClosestSourceInfo(el)
  const owner = getOwnerInvocationInfo(el)
  const mapped = getMappedIndexInfo(el, direct.sourceFile ?? null, direct.sourceLine ?? null)
  const prot = isProtectedElement(el)
  const remains = buildRemainsSummary(el)

  let hbItemId: string | null = null
  {
    let node: HTMLElement | null = el
    while (node) {
      const id = node.getAttribute('data-hb-item-id')
      if (id) { hbItemId = id; break }
      node = node.parentElement
    }
  }

  const tagLabel = el.tagName.toLowerCase()
  const fileBase = direct.sourceFile ? direct.sourceFile.split('/').pop() : null
  const displaySource = direct.sourceFile
    ? `${fileBase}${direct.sourceLine ? `:${direct.sourceLine}` : ''}`
    : 'unknown source'

  return {
    directFile: direct.sourceFile ?? null,
    directLine: direct.sourceLine ?? null,
    directCol: direct.sourceCol ?? null,
    directTag: direct.sourceTag ?? tagLabel,
    ownerFile: owner.file,
    ownerLine: owner.line,
    ownerCol: owner.col,
    ownerComponentName: owner.componentName,
    hbItemId,
    mappedIndex: mapped.index,
    mappedSiblingCount: mapped.siblingCount,
    isProtected: prot.protected,
    protectedReason: prot.reason,
    displayLabel: `<${tagLabel}>`,
    displaySource,
    remainingSiblingLabels: remains.siblings,
    remainingContainerLabel: remains.container,
  }
}

// ─── nested-element deletion candidates ────────────────────────────────────
// resolveSelectTarget()'s promotion (icon → wrapping <a>) is deliberately
// kept as the DEFAULT selection/delete behaviour — it's what makes ordinary
// clicking useful. This is an ADDITIONAL, explicit path: walk every fiber
// from the exact clicked DOM node up to the page root, in render order, and
// surface every level that safely maps to project source as a candidate the
// user can pick directly — deepest first, exactly matching what's visually
// nested inside what.

export interface DeletionCandidatePayload {
  candidateId: string
  depth: number
  kind: 'intrinsic-element' | 'component-instance'
  displayLabel: string
  target: DeletionTargetPayload
}

function labelForIntrinsic(el: HTMLElement, tagLabel: string): string {
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ')
  if (el.tagName === 'A') {
    const href = (el as HTMLAnchorElement).getAttribute('href')
    if (text) return `<a> "${text.slice(0, 28)}"`
    if (href) return `<a> (${href.slice(0, 24)})`
    return '<a> link'
  }
  if (text) return `<${tagLabel}> "${text.slice(0, 28)}"`
  return `<${tagLabel}>`
}

/**
 * Walk the fiber tree from `clickedEl`'s own fiber upward via `.return`,
 * collecting one candidate per safely-resolvable level:
 *
 *  - a HOST (intrinsic) fiber whose DOM node carries data-hb-file directly
 *    (a plain tag authored in a project file) → 'intrinsic-element'.
 *  - a COMPOSITE fiber (function/class/memo/forwardRef component) whose own
 *    `_debugSource` is present AND not under node_modules → 'component-instance',
 *    using that debug source as the invocation site directly (already
 *    correct — no redirect needed, unlike the DOM-metadata path where a
 *    non-forwarding component's own tag position can point at its
 *    definition file instead of its usage site).
 *
 * A host fiber with NO data-hb-file (a `<path>`/`<svg>` from an icon
 * library, or any other third-party-rendered DOM) and a composite fiber
 * with NO `_debugSource` (its component wasn't compiled by this project's
 * own dev pipeline — i.e. it's library code) are both silently skipped,
 * never becoming a candidate and never risking a node_modules write.
 */
function buildDeletionCandidates(clickedEl: HTMLElement): DeletionCandidatePayload[] {
  const candidates: DeletionCandidatePayload[] = []
  state.deletionCandidateEls = new Map()

  const fiberKey = Object.keys(clickedEl).find(
    (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
  )
  if (!fiberKey) return candidates

  const seenKeys = new Set<string>()
  let fiber = (clickedEl as unknown as Record<string, unknown>)[fiberKey] as Record<string, unknown> | null
  let depth = 0
  // Nearest real DOM element seen so far while walking upward. Updated on
  // every host fiber with a live stateNode — including third-party ones
  // without data-hb-file (e.g. a Lucide icon's inner <svg>/<path>) — so
  // composite (component) candidates can anchor their preview outline /
  // re-selection on it directly, instead of inferring from the candidates
  // array, which interleaves host and composite entries and can point at
  // a previously-pushed composite candidate rather than a real element.
  let lastHostEl: HTMLElement = clickedEl

  while (fiber && depth < 30 && candidates.length < 12) {
    const type = fiber.type

    if (typeof type === 'string') {
      const stateNode = fiber.stateNode
      if (stateNode instanceof HTMLElement) {
        lastHostEl = stateNode
      }
      if (stateNode instanceof HTMLElement && stateNode.hasAttribute('data-hb-file')) {
        const key = `${stateNode.getAttribute('data-hb-file')}:${stateNode.getAttribute('data-hb-line')}:${stateNode.getAttribute('data-hb-col')}`
        if (!seenKeys.has(key)) {
          seenKeys.add(key)
          const target = buildDeletionTarget(stateNode)
          const candidateId = `cand-${candidates.length}`
          state.deletionCandidateEls.set(candidateId, stateNode)
          candidates.push({
            candidateId,
            depth,
            kind: 'intrinsic-element',
            displayLabel: labelForIntrinsic(stateNode, type),
            target,
          })
          if (target.isProtected) break // nothing useful past html/head/body/root
        }
      }
    } else if (typeof type === 'function' || (typeof type === 'object' && type !== null)) {
      const src = fiber._debugSource as { fileName?: string; lineNumber?: number; columnNumber?: number } | undefined
      if (src?.fileName && !src.fileName.includes('/node_modules/') && !src.fileName.includes('\\node_modules\\')) {
        const named = type as { displayName?: string; name?: string }
        const compName = named.displayName ?? named.name ?? null
        if (compName) {
          const key = `${src.fileName}:${src.lineNumber}:${src.columnNumber}`
          if (!seenKeys.has(key)) {
            seenKeys.add(key)
            const fileBase = src.fileName.split('/').pop()
            const candidateId = `cand-${candidates.length}`
            // Component fibers have no single DOM node of their own — anchor
            // the preview outline / re-selection on the nearest real element
            // beneath it in the walk (the icon's rendered <svg>, etc.).
            state.deletionCandidateEls.set(candidateId, lastHostEl)
            const remains = buildRemainsSummary(lastHostEl)
            candidates.push({
              candidateId,
              depth,
              kind: 'component-instance',
              displayLabel: compName,
              target: {
                directFile: src.fileName,
                directLine: src.lineNumber ?? null,
                directCol: src.columnNumber ?? null,
                directTag: compName,
                ownerFile: null,
                ownerLine: null,
                ownerCol: null,
                ownerComponentName: null,
                hbItemId: null,
                mappedIndex: null,
                mappedSiblingCount: null,
                isProtected: false,
                protectedReason: null,
                displayLabel: compName,
                displaySource: `${fileBase}${src.lineNumber ? `:${src.lineNumber}` : ''}`,
                remainingSiblingLabels: remains.siblings,
                remainingContainerLabel: remains.container,
              },
            })
          }
        }
      }
    }

    fiber = fiber.return as Record<string, unknown> | null
    depth++
  }

  return candidates
}

/** Outline a candidate for preview without changing the actual selection. `null` clears it. */
function previewDeletionCandidate(candidateId: string | null): void {
  if (state.previewOutlineEl) {
    setOutline(state.previewOutlineEl, state.previewOutlineEl === state.selected ? SELECT_OUTLINE : '')
    state.previewOutlineEl = null
  }
  if (!candidateId) return
  const el = state.deletionCandidateEls.get(candidateId)
  if (!el) return
  state.previewOutlineEl = el
  setOutline(el, PREVIEW_OUTLINE)
}

/** Make a candidate the actual selection and report its own fully-resolved deletion target — used when the user picks a "Delete parent" option from the submenu. */
function selectDeletionCandidate(candidateId: string): void {
  const el = state.deletionCandidateEls.get(candidateId)
  if (!el) return

  clearSelected()
  state.selected = el
  setOutline(el, SELECT_OUTLINE)
  if (state.hovered === el) state.hovered = null
  // Keep the destructive preview outline on the newly-chosen candidate — it
  // carries into the confirm dialog that opens right after, same as the
  // default (deepest-safe) candidate does.
  previewDeletionCandidate(candidateId)

  const selectedData = collectData(el)
  ipcRenderer.sendToHost('inspector:selected', selectedData)
  ipcRenderer.sendToHost('inspector:candidate-selected', {
    selectedElement: selectedData,
    deletionTarget: buildDeletionTarget(el),
    fallbackIdentity: computeFallbackIdentity(el),
  })
}

interface FallbackIdentity {
  hbStyleId: string | null
  sourceFile: string | null
  sourceLine: number | null
  sourceCol: number | null
  hbItemId: string | null
  id: string | null
  tagName: string | null
  classList: string[]
  textPreview: string | null
  href: string | null
}

/**
 * Selection fallback order per the spec: next sibling → previous sibling →
 * parent. Computed BEFORE deletion (while `el` still exists) so it can ride
 * along in the same capture→write→restore flow every other save already
 * uses — restoreViewState just gets handed this identity instead of the
 * (now-gone) deleted element's own one.
 */
function computeFallbackIdentity(el: HTMLElement): FallbackIdentity | null {
  const candidates = [el.nextElementSibling, el.previousElementSibling, el.parentElement]
  for (const c of candidates) {
    if (!(c instanceof HTMLElement)) continue
    let node: HTMLElement | null = c
    while (node && node !== document.documentElement) {
      const attrs = readHbAttrs(node)
      if (attrs) {
        return {
          hbStyleId: Array.from(node.classList).find((cl) => /^hb-(style|instance)-[a-z0-9]+$/.test(cl))?.replace(/^hb-(style|instance)-/, '') ?? null,
          sourceFile: attrs.sourceFile ?? null,
          sourceLine: attrs.sourceLine ?? null,
          sourceCol: attrs.sourceCol ?? null,
          hbItemId: node.getAttribute('data-hb-item-id') ?? null,
          id: node.id || null,
          tagName: node.tagName.toLowerCase(),
          classList: Array.from(node.classList),
          textPreview: (node.textContent ?? '').trim().slice(0, 150) || null,
          href: node instanceof HTMLAnchorElement ? node.getAttribute('href') : null,
        }
      }
      node = node.parentElement
    }
  }
  return null
}

/**
 * The deepest DOM element actually under the cursor, independent of
 * `resolveSelectTarget()`'s ancestor promotion. Prefers `composedPath()`
 * (survives shadow-DOM boundaries `e.target` can collapse across),
 * falls back to `e.target`, then to `elementFromPoint` as a last resort.
 */
function getRawClickedElement(e: MouseEvent): HTMLElement | null {
  if (typeof e.composedPath === 'function') {
    const first = e.composedPath().find((n): n is HTMLElement => n instanceof HTMLElement)
    if (first) return first
  }
  if (e.target instanceof HTMLElement) return e.target
  const atPoint = document.elementFromPoint(e.clientX, e.clientY)
  return atPoint instanceof HTMLElement ? atPoint : null
}

/** First candidate (deepest-first order) that's safe to delete outright: not protected, and its source is actually known. */
function chooseActiveCandidate(candidates: DeletionCandidatePayload[]): DeletionCandidatePayload | null {
  return candidates.find((c) => !c.target.isProtected && !!c.target.directFile) ?? null
}

function onContextMenu(e: MouseEvent): void {
  if (!state.enabled) return // never show HandyBuilder's menu with Inspect mode off
  if (editState.active) return
  e.preventDefault()
  e.stopPropagation()

  // Captured BEFORE any smart-selection promotion runs — this, not the
  // promoted edit target, is what deletion candidate-building starts from.
  const clickedElement = getRawClickedElement(e)
  if (!clickedElement) return
  state.lastContextMenuElement = clickedElement

  // Smart-resolved target — still drives the ordinary blue Inspector
  // selection highlight, exactly like a left click would. It is NOT used to
  // seed deletion candidates anymore; that's the bug this fixes.
  const { el: resolved, resolvedFrom } = resolveSelectTarget(clickedElement)

  clearSelected()
  state.lastAppliedStyleProps.clear()
  state.selected = resolved
  state.lastClickPoint = { x: e.clientX, y: e.clientY }
  setOutline(resolved, SELECT_OUTLINE)
  if (state.hovered === resolved) state.hovered = null

  const candidates = buildDeletionCandidates(clickedElement)
  const active = chooseActiveCandidate(candidates)
  const activeEl = active ? state.deletionCandidateEls.get(active.candidateId) ?? resolved : resolved
  const activeTarget = active ? active.target : buildDeletionTarget(resolved)

  // Show the destructive preview outline on the actual default deletion
  // target immediately — the user shouldn't have to hover a submenu to see
  // what "Delete" is about to remove.
  previewDeletionCandidate(active?.candidateId ?? null)

  // ── diagnostics ──────────────────────────────────────────────────────────
  log(`[delete-target] raw event target: ${describeEl(e.target as HTMLElement)}`)
  if (typeof e.composedPath === 'function') {
    const pathLabels = e.composedPath()
      .filter((n): n is HTMLElement => n instanceof HTMLElement)
      .slice(0, 8)
      .map(describeEl)
    log(`[delete-target] composed path: ${pathLabels.join(' → ')}`)
  }
  log(`[delete-target] smart edit target: ${describeEl(resolved)}`)
  candidates.forEach((c, i) => {
    const safe = !c.target.isProtected && !!c.target.directFile
    log(`[delete-target] ${i} ${c.displayLabel} — ${safe ? 'safe' : 'unsafe'} — ${c.target.displaySource}`)
  })
  if (active) {
    log(`[delete-target] active delete candidate: ${active.displayLabel} — ${active.target.displaySource}`)
  } else {
    log(`[delete-target] no safe nested candidate resolved — falling back to smart target ${describeEl(resolved)} (reason: ${candidates.length === 0 ? 'no candidates built (no fiber found)' : 'every candidate was protected or had no known source'})`)
  }

  const selectedData = collectData(resolved, resolvedFrom, state.lastClickPoint)
  ipcRenderer.sendToHost('inspector:selected', selectedData)
  ipcRenderer.sendToHost('inspector:context-menu', {
    clientX: e.clientX,
    clientY: e.clientY,
    selectedElement: selectedData,
    // The DEFAULT deletion target is now the deepest safe candidate, not the
    // smart-promoted `resolved` element — right-clicking the icon inside
    // `<a className="logo"><LeafIcon/><span>...</span></a>` must default to
    // deleting the icon, never the whole link.
    deletionTarget: activeTarget,
    activeCandidateId: active?.candidateId ?? null,
    fallbackIdentity: computeFallbackIdentity(activeEl),
    // Full deepest-to-outermost chain, built from the exact clicked node —
    // the UI derives "Delete parent ▸" options from whatever comes after
    // the active candidate in this list.
    deletionCandidates: candidates,
  })
}

/** Delete/Backspace while an element is selected and Inspect mode is active — goes straight to the confirm dialog (no menu step). */
function onDeleteKeyDown(e: KeyboardEvent): void {
  if (!state.enabled) return
  if (editState.active) return
  if (!state.selected) return
  if (e.key !== 'Delete' && e.key !== 'Backspace') return

  const activeEl = document.activeElement as HTMLElement | null
  if (activeEl) {
    const tag = activeEl.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || activeEl.isContentEditable) return
  }

  e.preventDefault()
  const selectedData = collectData(state.selected)
  ipcRenderer.sendToHost('inspector:delete-requested', {
    selectedElement: selectedData,
    deletionTarget: buildDeletionTarget(state.selected),
    fallbackIdentity: computeFallbackIdentity(state.selected),
    deletionCandidates: buildDeletionCandidates(state.selected),
  })
}

// ─── IPC setup ────────────────────────────────────────────────────────────────

function setup(): void {
  log('setup() — registering IPC listeners')
  ipcRenderer.on('inspector:enable',  () => { log('IPC → inspector:enable');  enable()  })
  ipcRenderer.on('inspector:disable', () => { log('IPC → inspector:disable'); disable() })
  ipcRenderer.on('inspector:clear',   () => { clearHover(); clearSelected() })
  ipcRenderer.on('editor:apply-dom-patch', (_e, patch: DomPatch) => applyDomPatch(patch))
  ipcRenderer.on('editor:capture-view-state', () => {
    ipcRenderer.sendToHost('inspector:view-captured', captureViewState())
  })
  ipcRenderer.on('editor:restore-view-state', (_e, target: RestoreViewStateParams) => restoreViewState(target))
  ipcRenderer.on('editor:preview-candidate', (_e, candidateId: string | null) => previewDeletionCandidate(candidateId))
  ipcRenderer.on('editor:select-candidate', (_e, candidateId: string) => selectDeletionCandidate(candidateId))
  patchHistory()
}

if (document.readyState === 'loading') {
  log('DOM not ready — waiting for DOMContentLoaded')
  document.addEventListener('DOMContentLoaded', setup)
} else {
  log('DOM already ready — calling setup() immediately')
  setup()
}
