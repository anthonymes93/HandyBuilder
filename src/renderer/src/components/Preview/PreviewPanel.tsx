import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Project, DevServerStatus, SelectedElement,
  WebviewElement, IpcMessageEvent, TextEditPayload, DomPatch,
  DeletionTarget, ElementContextMenuRequest, DeleteKeyRequest, ElementIdentityLike,
  DeletionCandidate, CandidateSelectedMessage
} from '../../types'
import { ElementIdentity } from '../../utils/elementIdentity'
import { WelcomeScreen } from './WelcomeScreen'
import { ElementContextMenu } from '../Inspector/ElementContextMenu'
import { DeleteConfirmDialog } from '../Inspector/DeleteConfirmDialog'

/** Scroll/route facts captured from the webview, before identity is attached by usePreviewViewState. */
export interface CapturedViewStateBase {
  href: string
  pathname: string
  scrollX: number
  scrollY: number
  documentHeight: number
  viewportHeight: number
  elementViewportOffsetY: number | null
  /** The bridge's document generation at capture time — compared after restore to tell a full reload (different id) apart from Fast Refresh (same id). */
  documentGenerationId: string | null
}

export interface PreviewViewState extends CapturedViewStateBase {
  identity: ElementIdentity | null
  /** Short id used to correlate every log line / debug-panel update for one save/undo/redo across the whole capture→write→restore sequence. */
  operationId: string
}

export interface RestoreAck {
  success: boolean
  method: string
  scrollY: number
  elementFound: boolean
  documentGenerationId: string
}

/** Mirrors the bridge round-trip a restore actually goes through — surfaced only for the dev debug panel / console timeline. */
export type PreviewReloadState =
  | 'idle'
  | 'save-started'
  | 'waiting-for-reload'
  | 'reload-started'
  | 'dom-ready'
  | 'reload-finished'
  | 'restoring'
  | 'restored'

interface DebugSnapshot {
  operationId: string
  capturedGeneration: string | null
  currentGeneration: string | null
  reloadState: PreviewReloadState
  capturedScrollY: number
  currentScrollY: number | null
  targetScrollY: number
  elementFound: boolean | null
  lastEvent: string
}

export interface PreviewFrameHandle {
  clearInspector: () => void
  applyDomPatch: (patch: DomPatch) => void
  checkHbInjection: () => Promise<HbInjectionDiagnostic>
  /** Count elements in the live preview matching a CSS selector — used to verify a style edit stayed isolated to one element. */
  countMatchingElements: (selector: string) => Promise<number>
  /**
   * Confirm the live preview actually renders the newly-saved background
   * image after HMR — as opposed to the DOM-only preview patch applied
   * before Save. Returns null when the owner element/rule can't be found
   * (inconclusive — never used to fail a save on its own).
   */
  verifyBackgroundImage: (params: BackgroundVerifyParams) => Promise<boolean | null>
  /** Snapshot scroll position + route from the live preview, before a source write. */
  captureViewState: () => Promise<CapturedViewStateBase | null>
  /**
   * Re-apply a previously captured view state. Waits for an actual reload
   * lifecycle signal (a NEW bridge document-generation id) rather than a
   * blind timer before restoring against the replacement document; if no
   * reload begins within ~2s it's treated as a Fast Refresh (same document)
   * and restored against directly. Either way, corrects repeatedly for
   * ~1.5s afterward to ride out late layout shifts. Safe/idempotent to call
   * even when nothing moved.
   */
  restoreViewState: (state: PreviewViewState) => Promise<RestoreAck | null>
  /**
   * Mark whether the next `did-start-loading` is an EXPECTED save/undo/redo
   * reload (selection must be preserved) vs. genuine user navigation, a
   * manual Reload, or opening a different project (selection should clear).
   * MUST be called before the source file is written — Vite's watcher can
   * react before our own await chain would otherwise get to it.
   */
  setExpectingReload: (expecting: boolean, operationId?: string) => void
}

export interface BackgroundVerifyParams {
  file: string | null
  line: number | null
  cssSelector: string | null
  mode: 'img-src' | 'bg-image' | 'pseudo-before' | 'pseudo-after'
  expectedUrlFragment: string
}

export interface HbMetadataElement {
  tagName: string
  file: string | null
  line: string | null
  col: string | null
  text: string
}

export interface HbInjectionDiagnostic {
  currentUrl: string
  hasDataHbFile: boolean
  hasDataHbLine: boolean
  hasDataHbCol: boolean
  metadataCount: number
  sampleElements: HbMetadataElement[]
  pluginActive: boolean
  bodyHtmlSample: string
  failure?: string
}

interface PreviewPanelProps {
  url: string | null
  status: DevServerStatus
  project: Project | null
  isInspectMode: boolean
  bridgePath: string | null
  onElementSelected: (el: SelectedElement) => void
  onPageNavigated: () => void
  onTextSaved: (payload: TextEditPayload) => void
  /** Runs the actual AST deletion (+ view-state preservation); resolves once the write (and, on success, restoration) is complete. */
  onDeleteElement: (target: DeletionTarget, fallbackIdentity: ElementIdentityLike | null, operationId: string) => Promise<{ success: boolean; error?: string }>
}

const LOADING_MESSAGES: Partial<Record<DevServerStatus, string>> = {
  installing: 'Installing dependencies…',
  starting: 'Starting dev server…',
  idle: 'Waiting for dev server…',
  stopped: 'Dev server stopped',
  error: 'Dev server error'
}

export const PreviewPanel = forwardRef<PreviewFrameHandle, PreviewPanelProps>(
  function PreviewPanel(
    { url, status, project, isInspectMode, bridgePath, onElementSelected, onPageNavigated, onTextSaved, onDeleteElement },
    ref
  ) {
    const webviewRef = useRef<WebviewElement>(null)
    const isReadyRef = useRef(false)
    // Stable ref so dom-ready handler always sees latest mode without re-registering
    const isInspectModeRef = useRef(isInspectMode)
    isInspectModeRef.current = isInspectMode

    // ── view-state capture/restore plumbing ─────────────────────────────────
    // When true, the next did-start-loading is a reload WE caused by writing
    // a source file (save/undo/redo) — selection must survive it. Genuine
    // user navigation, a manual Reload click, or opening a different project
    // leave this false, so onPageNavigated() still fires as before.
    const expectingReloadRef = useRef(false)
    const activeOperationIdRef = useRef<string | null>(null)
    const pendingCaptureRef = useRef<((base: CapturedViewStateBase) => void) | null>(null)
    const pendingRestoreRef = useRef<((ack: RestoreAck) => void) | null>(null)
    // The current document's generation id, as last reported by bridge:ready
    // (sent fresh by the preload script on every real navigation/reload, but
    // NOT on a Fast Refresh HMR patch — same script instance, same id). This
    // is the authoritative "did a full reload actually happen" signal.
    const bridgeGenerationRef = useRef<string | null>(null)
    // Resolved by onStartLoading — lets restoreViewState await "a reload
    // actually began" instead of guessing from a fixed timer.
    const reloadStartedWaiterRef = useRef<(() => void) | null>(null)
    // Resolved by the bridge:ready handler once a generation DIFFERENT from
    // the one being waited on arrives — i.e. the replacement document's
    // bridge is alive and ready to receive a restore command.
    const bridgeReadyWaiterRef = useRef<{ since: string | null; resolve: (gen: string) => void } | null>(null)
    // Dev-only diagnostics — see the debug panel in the render below. Routed
    // through a ref (rather than called directly) so the event-listener
    // effect's closures — which don't re-create on every render — always
    // reach the current setState function.
    const debugRef = useRef<DebugSnapshot | null>(null)
    const [debugSnapshot, setDebugSnapshot] = useState<DebugSnapshot | null>(null)
    const debugSetterRef = useRef<((snap: DebugSnapshot | null) => void) | null>(null)
    debugSetterRef.current = setDebugSnapshot

    // ── right-click context menu / delete confirm ───────────────────────────
    const [contextMenu, setContextMenu] = useState<{
      x: number; y: number; target: DeletionTarget; fallbackIdentity: ElementIdentityLike | null
      candidates: DeletionCandidate[]; activeCandidateId: string | null
    } | null>(null)
    const [deleteConfirm, setDeleteConfirm] = useState<{
      target: DeletionTarget; fallbackIdentity: ElementIdentityLike | null
    } | null>(null)
    const [deleteBusy, setDeleteBusy] = useState(false)
    const [deleteError, setDeleteError] = useState<string | null>(null)
    const containerRef = useRef<HTMLDivElement>(null)

    /** Guest-page (webview-relative) clientX/Y → coordinates relative to this component's own positioned container, so the menu/dialog can be absolutely positioned over the webview correctly. */
    function toContainerCoords(clientX: number, clientY: number): { x: number; y: number } {
      const webview = webviewRef.current
      const container = containerRef.current
      if (!webview || !container) return { x: clientX, y: clientY }
      const webviewRect = webview.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()
      return {
        x: clientX + (webviewRect.left - containerRect.left),
        y: clientY + (webviewRect.top - containerRect.top),
      }
    }

    async function handleConfirmDelete() {
      if (!deleteConfirm || deleteBusy) return
      const operationId = `del-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      console.log(`[delete ${operationId}] confirmation accepted`)
      setDeleteBusy(true)
      setDeleteError(null)
      try {
        const result = await onDeleteElement(deleteConfirm.target, deleteConfirm.fallbackIdentity, operationId)
        if (!result?.success) {
          throw new Error(result?.error || 'Element was not deleted.')
        }
        webviewRef.current?.send('editor:preview-candidate', null)
        setDeleteConfirm(null)
        setContextMenu(null)
      } catch (err) {
        // Anything thrown anywhere in the chain (IPC rejection, a bug in the
        // writer, a timeout) lands here instead of leaving the dialog
        // stuck on "Deleting…" forever with no feedback.
        console.error('[delete-ui] deletion failed', err)
        setDeleteError(err instanceof Error ? err.message : 'Element was not deleted.')
      } finally {
        setDeleteBusy(false)
      }
    }

    function updateDebug(patch: Partial<DebugSnapshot>): void {
      if (!import.meta.env.DEV) return
      const next: DebugSnapshot = {
        operationId: debugRef.current?.operationId ?? '',
        capturedGeneration: debugRef.current?.capturedGeneration ?? null,
        currentGeneration: bridgeGenerationRef.current,
        reloadState: debugRef.current?.reloadState ?? 'idle',
        capturedScrollY: debugRef.current?.capturedScrollY ?? 0,
        currentScrollY: debugRef.current?.currentScrollY ?? null,
        targetScrollY: debugRef.current?.targetScrollY ?? 0,
        elementFound: debugRef.current?.elementFound ?? null,
        lastEvent: debugRef.current?.lastEvent ?? '',
        ...patch,
      }
      debugRef.current = next
      debugSetterRef.current?.(next)
    }

    function opLog(operationId: string, msg: string): void {
      console.log(`[view-state ${operationId}] ${msg}`)
    }

    useImperativeHandle(ref, () => ({
      clearInspector() {
        if (webviewRef.current && isReadyRef.current) {
          webviewRef.current.send('inspector:clear')
        }
      },
      applyDomPatch(patch: DomPatch) {
        if (webviewRef.current && isReadyRef.current) {
          webviewRef.current.send('editor:apply-dom-patch', patch)
        }
      },
      async checkHbInjection() {
        const webview = webviewRef.current
        if (!webview || !isReadyRef.current) {
          throw new Error('Preview webview is not ready. Wait for the page to load and try again.')
        }
        return webview.executeJavaScript<HbInjectionDiagnostic>(`(() => {
          const nodes = Array.from(document.querySelectorAll('[data-hb-file]'));
          const pluginActive = window.__HANDYBUILDER_SOURCE_PLUGIN_ACTIVE__ === true;
          const result = {
            currentUrl: window.location.href,
            hasDataHbFile: document.querySelector('[data-hb-file]') !== null,
            hasDataHbLine: document.querySelector('[data-hb-line]') !== null,
            hasDataHbCol: document.querySelector('[data-hb-col]') !== null,
            metadataCount: nodes.length,
            sampleElements: nodes.slice(0, 5).map((el) => ({
              tagName: el.tagName.toLowerCase(),
              file: el.getAttribute('data-hb-file'),
              line: el.getAttribute('data-hb-line'),
              col: el.getAttribute('data-hb-col'),
              text: (el.textContent || '').trim().slice(0, 160)
            })),
            pluginActive,
            bodyHtmlSample: (document.body?.outerHTML || '').slice(0, 1000)
          };
          if (!result.hasDataHbFile) {
            result.failure = pluginActive
              ? 'The HandyBuilder wrapper plugin is active, but no data-hb-file attributes reached the DOM. Check the [hb-plugin] transform logs and transformed code sample.'
              : 'The HandyBuilder source plugin marker is missing. The preview is likely not running through .handybuilder/vite.config.hb.mjs; check the [handybuilder] launch command and wrapper-config log.';
          }
          return result;
        })()`)
      },
      async countMatchingElements(selector: string) {
        const webview = webviewRef.current
        if (!webview || !isReadyRef.current) return -1
        try {
          return await webview.executeJavaScript<number>(
            `document.querySelectorAll(${JSON.stringify(selector)}).length`
          )
        } catch {
          return -1
        }
      },
      async verifyBackgroundImage(params: BackgroundVerifyParams) {
        const webview = webviewRef.current
        if (!webview || !isReadyRef.current) return null
        try {
          return await webview.executeJavaScript<boolean | null>(`(() => {
            const params = ${JSON.stringify(params)};
            function findByFileLine() {
              if (!params.file || params.line == null) return null;
              const nodes = document.querySelectorAll('[data-hb-file]');
              for (const n of nodes) {
                if (n.getAttribute('data-hb-file') === params.file && n.getAttribute('data-hb-line') === String(params.line)) return n;
              }
              return null;
            }
            function findBySelector() {
              if (!params.cssSelector) return null;
              const base = params.cssSelector.replace(/::?(before|after)\\s*$/, '').trim();
              try { return base ? document.querySelector(base) : null; } catch { return null; }
            }
            const el = findByFileLine() || findBySelector();
            if (!el) return null;
            let value = '';
            if (params.mode === 'img-src') value = el.currentSrc || el.src || '';
            else if (params.mode === 'pseudo-before') value = getComputedStyle(el, '::before').backgroundImage;
            else if (params.mode === 'pseudo-after') value = getComputedStyle(el, '::after').backgroundImage;
            else value = getComputedStyle(el).backgroundImage;
            return value.includes(params.expectedUrlFragment);
          })()`)
        } catch {
          return null
        }
      },
      setExpectingReload(expecting: boolean, operationId?: string) {
        expectingReloadRef.current = expecting
        activeOperationIdRef.current = expecting ? operationId ?? null : null
        if (expecting && operationId) {
          updateDebug({ operationId, reloadState: 'save-started', lastEvent: 'setExpectingReload(true)' })
          opLog(operationId, `armed — expecting a possible reload (current gen=${bridgeGenerationRef.current ?? 'unknown'})`)
        }
      },
      async captureViewState() {
        const webview = webviewRef.current
        if (!webview || !isReadyRef.current) return null
        return new Promise<CapturedViewStateBase | null>((resolve) => {
          pendingCaptureRef.current = (base) => resolve(base)
          webview.send('editor:capture-view-state')
          setTimeout(() => {
            if (pendingCaptureRef.current) {
              pendingCaptureRef.current = null
              resolve(null)
            }
          }, 400)
        })
      },
      async restoreViewState(target: PreviewViewState) {
        const opId = target.operationId
        const log = (msg: string) => opLog(opId, msg)
        updateDebug({
          operationId: opId,
          capturedGeneration: target.documentGenerationId,
          targetScrollY: target.scrollY,
          capturedScrollY: target.scrollY,
          reloadState: 'waiting-for-reload',
          lastEvent: 'restore requested',
        })
        log(`restore requested — captured gen=${target.documentGenerationId ?? 'unknown'} scrollY=${target.scrollY}`)

        // ── Step 1: did a real reload actually begin? A generation that has
        // ALREADY changed by the time we get here means it happened before
        // we could even start waiting — otherwise race did-start-loading
        // against a ~2s "assume Fast Refresh" timeout. ──
        let reloadBegan = !!target.documentGenerationId && bridgeGenerationRef.current !== target.documentGenerationId
        if (!reloadBegan) {
          reloadBegan = await new Promise<boolean>((resolve) => {
            let done = false
            reloadStartedWaiterRef.current = () => { if (!done) { done = true; resolve(true) } }
            setTimeout(() => {
              if (!done) { done = true; reloadStartedWaiterRef.current = null; resolve(false) }
            }, 2000)
          })
        }

        if (reloadBegan) {
          log('did-start-loading observed (or generation already changed) — full-reload path')
          updateDebug({ reloadState: 'reload-started', lastEvent: 'did-start-loading' })

          if (bridgeGenerationRef.current === target.documentGenerationId) {
            // Reload started but the replacement bridge hasn't reported in yet.
            const newGeneration = await new Promise<string | null>((resolve) => {
              let done = false
              bridgeReadyWaiterRef.current = {
                since: target.documentGenerationId,
                resolve: (gen) => { if (!done) { done = true; resolve(gen) } },
              }
              setTimeout(() => {
                if (!done) { done = true; bridgeReadyWaiterRef.current = null; resolve(null) }
              }, 8000) // dev-server rebuilds can take a moment — generous on purpose
            })
            if (!newGeneration) {
              log('timed out waiting for the new document\'s bridge — giving up on this attempt')
              updateDebug({ reloadState: 'idle', lastEvent: 'gave up: no new bridge' })
              return null
            }
            log(`new bridge ready gen=${newGeneration}`)
          } else {
            log(`generation already advanced to ${bridgeGenerationRef.current}`)
          }
          updateDebug({ reloadState: 'dom-ready', lastEvent: 'bridge:ready (new generation)' })
        } else {
          log('no did-start-loading within 2s — treating as Fast Refresh (same document)')
        }

        // ── Step 2: restore-attempt schedule against whatever is now the
        // CURRENT document — either the confirmed replacement, or the same
        // one if this was Fast Refresh. Never against the pre-reload document. ──
        updateDebug({ reloadState: 'restoring', lastEvent: 'restore attempts starting' })
        const schedule: Array<number | 'raf'> = [0, 'raf', 50, 150, 350, 750, 1250]
        let lastAck: RestoreAck | null = null
        for (const step of schedule) {
          if (step === 'raf') await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          else if (step > 0) await new Promise((resolve) => setTimeout(resolve, step))

          const webview = webviewRef.current
          if (!webview || !isReadyRef.current) {
            log(`attempt @${step} — webview not ready yet, will retry`)
            continue
          }
          lastAck = await new Promise<RestoreAck | null>((resolve) => {
            pendingRestoreRef.current = (ack) => resolve(ack)
            webview.send('editor:restore-view-state', target)
            setTimeout(() => {
              if (pendingRestoreRef.current) {
                pendingRestoreRef.current = null
                resolve(null)
              }
            }, 400)
          })
          log(`attempt @${step} → ${lastAck ? `success=${lastAck.success} method=${lastAck.method} scrollY=${lastAck.scrollY} elementFound=${lastAck.elementFound}` : 'no response'}`)
          updateDebug({
            currentScrollY: lastAck?.scrollY ?? null,
            elementFound: lastAck?.elementFound ?? null,
            lastEvent: `restore attempt @${step}`,
          })
          if (lastAck?.success) break
        }
        updateDebug({ reloadState: 'restored', lastEvent: 'restore sequence finished' })
        log(`finished — ${lastAck?.success ? 'restored' : 'gave up'} (last ack: ${JSON.stringify(lastAck)})`)
        return lastAck
      }
    }))

    // ── sync inspect mode whenever it changes ──────────────────────────────
    useEffect(() => {
      console.log('[preview] isInspectMode →', isInspectMode, '| ready:', isReadyRef.current)
      if (!webviewRef.current || !isReadyRef.current) return
      webviewRef.current.send(isInspectMode ? 'inspector:enable' : 'inspector:disable')
    }, [isInspectMode])

    // ── IPC message handler (stable across renders) ────────────────────────
    const onIpcMessage = useCallback(
      (e: IpcMessageEvent) => {
        if (e.channel === 'bridge:log') {
          console.log('[bridge]', e.args[0])
          return
        }
        console.log('[preview] ipc-message', e.channel, e.args[0])
        if (e.channel === 'inspector:selected') {
          onElementSelected(e.args[0] as SelectedElement)
          // A right-click re-selects before opening the menu, so this fires
          // right before 'inspector:context-menu' for that same interaction
          // — harmless, since the menu is set immediately after. Any OTHER
          // selection (a plain click elsewhere) should close a stale menu.
          setContextMenu(null)
        } else if (e.channel === 'inspector:context-menu') {
          const req = e.args[0] as ElementContextMenuRequest
          const { x, y } = toContainerCoords(req.clientX, req.clientY)
          setContextMenu({
            x, y, target: req.deletionTarget, fallbackIdentity: req.fallbackIdentity,
            candidates: req.deletionCandidates, activeCandidateId: req.activeCandidateId,
          })
        } else if (e.channel === 'inspector:delete-requested') {
          const req = e.args[0] as DeleteKeyRequest
          setContextMenu(null)
          setDeleteError(null)
          setDeleteConfirm({ target: req.deletionTarget, fallbackIdentity: req.fallbackIdentity })
        } else if (e.channel === 'inspector:candidate-selected') {
          // User picked a specific nested candidate from the submenu — skip
          // straight to the confirm dialog for that exact node, bypassing the
          // top-level (possibly-promoted) target entirely.
          const req = e.args[0] as CandidateSelectedMessage
          setContextMenu(null)
          setDeleteError(null)
          setDeleteConfirm({ target: req.deletionTarget, fallbackIdentity: req.fallbackIdentity })
        } else if (e.channel === 'editor:text-saved') {
          // onTextSaved is async (returns Promise<SaveStatus>).  We must catch any
          // rejection here — if we let it float, the UI stays stuck at "Saving…"
          // because setSaveResult({ status: 'saving' }) was already called but
          // no subsequent setSaveResult ever fires.
          void Promise.resolve(onTextSaved(e.args[0] as TextEditPayload)).catch(
            (err: unknown) => console.error('[preview] onTextSaved rejected:', err)
          )
        } else if (e.channel === 'inspector:route-changed') {
          console.log('[preview] SPA route changed', e.args[0])
          onPageNavigated()
          if (isInspectModeRef.current) {
            setTimeout(() => { webviewRef.current?.send('inspector:enable') }, 50)
          }
        } else if (e.channel === 'inspector:view-captured') {
          pendingCaptureRef.current?.(e.args[0] as CapturedViewStateBase)
          pendingCaptureRef.current = null
        } else if (e.channel === 'inspector:view-restored') {
          pendingRestoreRef.current?.(e.args[0] as RestoreAck)
          pendingRestoreRef.current = null
        } else if (e.channel === 'bridge:ready') {
          const { documentGenerationId, href } = e.args[0] as { documentGenerationId: string; href: string }
          const previous = bridgeGenerationRef.current
          bridgeGenerationRef.current = documentGenerationId
          const opId = activeOperationIdRef.current
          if (opId) opLog(opId, `bridge:ready gen=${documentGenerationId} href=${href} (previous gen=${previous ?? 'none'})`)
          updateDebug({ currentGeneration: documentGenerationId, lastEvent: `bridge:ready gen=${documentGenerationId}` })
          // A waiter is only listening for a generation DIFFERENT from the
          // one it captured before the write — the very first bridge:ready
          // after page load (or a same-generation Fast Refresh) must not
          // satisfy it.
          const waiter = bridgeReadyWaiterRef.current
          if (waiter && documentGenerationId !== waiter.since) {
            bridgeReadyWaiterRef.current = null
            waiter.resolve(documentGenerationId)
          }
        }
      },
      [onElementSelected, onTextSaved, onPageNavigated]
    )

    // ── attach webview event listeners ─────────────────────────────────────
    // BUG FIX: deps MUST include `url` and `bridgePath` so this effect re-runs
    // once the webview actually enters the DOM (the component returns early when
    // either is null, so webviewRef.current is null on the first run).
    useEffect(() => {
      const webview = webviewRef.current
      console.log('[preview] listener effect | webview:', !!webview, 'url:', !!url, 'bridge:', !!bridgePath)
      if (!webview) return

      function onDomReady() {
        console.log('[preview] dom-ready | will send:', isInspectModeRef.current ? 'enable' : 'disable')
        isReadyRef.current = true
        webview!.send(isInspectModeRef.current ? 'inspector:enable' : 'inspector:disable')
      }

      function lifecycleLog(name: string) {
        const opId = activeOperationIdRef.current
        const line = `${name} url=${webview!.src ?? ''}`
        if (opId) opLog(opId, line)
        else console.log(`[preview] ${line}`)
        updateDebug({ lastEvent: name })
      }

      function onStartLoading() {
        const expected = expectingReloadRef.current
        lifecycleLog(`did-start-loading${expected ? ' (expected save/undo/redo reload — preserving selection)' : ''}`)
        isReadyRef.current = false
        // Wake up any restoreViewState() waiting to learn whether a reload
        // actually began, instead of it having to guess from a fixed timer.
        reloadStartedWaiterRef.current?.()
        reloadStartedWaiterRef.current = null
        // A save/undo/redo-triggered reload must not be treated as user
        // navigation — onPageNavigated() would null the selected element and
        // unmount the Inspector's style editors, losing their local state
        // (accordion/tab) right before we try to restore the same selection.
        if (!expected) onPageNavigated()
      }

      function onDidStopLoading() {
        lifecycleLog('did-stop-loading')
      }

      function onDidFinishLoad() {
        lifecycleLog('did-finish-load')
      }

      function onRenderProcessGone() {
        lifecycleLog('render-process-gone')
        isReadyRef.current = false
      }

      function onDidNavigate() {
        lifecycleLog('did-navigate — full navigation')
        isReadyRef.current = false
      }

      function onDidNavigateInPage() {
        lifecycleLog('did-navigate-in-page — SPA navigation')
        // Bridge sends inspector:route-changed for the same event; this is a
        // safety net in case the bridge message is delayed or dropped.
        isReadyRef.current = true
        onPageNavigated()
        if (isInspectModeRef.current) {
          setTimeout(() => { webview!.send('inspector:enable') }, 50)
        }
      }

      webview.addEventListener('dom-ready', onDomReady)
      webview.addEventListener('did-start-loading', onStartLoading)
      webview.addEventListener('did-stop-loading', onDidStopLoading)
      webview.addEventListener('did-finish-load', onDidFinishLoad)
      webview.addEventListener('render-process-gone', onRenderProcessGone)
      webview.addEventListener('did-navigate', onDidNavigate)
      webview.addEventListener('did-navigate-in-page', onDidNavigateInPage)
      webview.addEventListener('ipc-message', onIpcMessage)

      return () => {
        webview.removeEventListener('dom-ready', onDomReady)
        webview.removeEventListener('did-start-loading', onStartLoading)
        webview.removeEventListener('did-stop-loading', onDidStopLoading)
        webview.removeEventListener('did-finish-load', onDidFinishLoad)
        webview.removeEventListener('render-process-gone', onRenderProcessGone)
        webview.removeEventListener('did-navigate', onDidNavigate)
        webview.removeEventListener('did-navigate-in-page', onDidNavigateInPage)
        webview.removeEventListener('ipc-message', onIpcMessage)
      }
    }, [onIpcMessage, onPageNavigated, url, bridgePath]) // ← url + bridgePath are the critical additions

    // ── render ─────────────────────────────────────────────────────────────
    if (!project) return <WelcomeScreen />

    if (!url) {
      const message = LOADING_MESSAGES[status] ?? 'Waiting for dev server…'
      const isError = status === 'error' || status === 'stopped'
      return (
        <div className="flex-1 flex flex-col items-center justify-center bg-gray-950 gap-4">
          {!isError && <Loader2 className="w-7 h-7 text-gray-700 animate-spin" />}
          <div className="text-center">
            <p className={`text-sm font-medium ${isError ? 'text-red-400' : 'text-gray-400'}`}>
              {message}
            </p>
            <p className="text-gray-700 text-xs mt-1">{project.name}</p>
          </div>
        </div>
      )
    }

    return (
      <div ref={containerRef} className="relative flex-1 flex flex-col bg-gray-950 overflow-hidden">
        {contextMenu && (
          <ElementContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            target={contextMenu.target}
            activeCandidateId={contextMenu.activeCandidateId}
            candidates={contextMenu.candidates}
            bounds={containerRef.current
              ? { width: containerRef.current.clientWidth, height: containerRef.current.clientHeight }
              : { width: 9999, height: 9999 }}
            onDelete={() => {
              // Deliberately do NOT clear the destructive preview outline here —
              // it's already showing the exact default target (set the instant
              // the menu opened) and should stay visible through the confirm
              // step below, not disappear and reappear.
              setDeleteError(null)
              setDeleteConfirm({ target: contextMenu.target, fallbackIdentity: contextMenu.fallbackIdentity })
              setContextMenu(null)
            }}
            onClose={() => {
              webviewRef.current?.send('editor:preview-candidate', null)
              setContextMenu(null)
            }}
            onPreviewCandidate={(candidateId) => {
              if (webviewRef.current && isReadyRef.current) {
                webviewRef.current.send('editor:preview-candidate', candidateId)
              }
            }}
            onSelectCandidate={(candidateId) => {
              if (webviewRef.current && isReadyRef.current) {
                webviewRef.current.send('editor:select-candidate', candidateId)
              }
              setContextMenu(null)
            }}
          />
        )}
        {deleteConfirm && (
          <DeleteConfirmDialog
            target={deleteConfirm.target}
            busy={deleteBusy}
            error={deleteError}
            onCancel={() => {
              webviewRef.current?.send('editor:preview-candidate', null)
              setDeleteConfirm(null)
              setDeleteError(null)
            }}
            onConfirm={handleConfirmDelete}
          />
        )}
        {import.meta.env.DEV && debugSnapshot && (
          <div className="absolute bottom-2 right-2 z-50 w-64 rounded border border-gray-700 bg-gray-950/95 p-2 font-mono text-[10px] leading-relaxed text-gray-300 shadow-lg pointer-events-none">
            <div className="mb-1 text-gray-500">view-state debug</div>
            <div>Operation: <span className="text-gray-100">{debugSnapshot.operationId || '—'}</span></div>
            <div>Captured gen: <span className="text-gray-100">{debugSnapshot.capturedGeneration ?? '—'}</span></div>
            <div>Current gen: <span className="text-gray-100">{debugSnapshot.currentGeneration ?? '—'}</span></div>
            <div>Reload state: <span className="text-blue-300">{debugSnapshot.reloadState}</span></div>
            <div>Captured scrollY: <span className="text-gray-100">{debugSnapshot.capturedScrollY}</span></div>
            <div>Current scrollY: <span className="text-gray-100">{debugSnapshot.currentScrollY ?? '—'}</span></div>
            <div>Target scrollY: <span className="text-gray-100">{debugSnapshot.targetScrollY}</span></div>
            <div>Element found: <span className="text-gray-100">{debugSnapshot.elementFound === null ? '—' : debugSnapshot.elementFound ? 'yes' : 'no'}</span></div>
            <div>Last event: <span className="text-gray-100">{debugSnapshot.lastEvent || '—'}</span></div>
          </div>
        )}
        <div className="h-8 flex items-center gap-2 px-3 bg-gray-900 border-b border-gray-800 shrink-0">
          <div className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
          <span className="flex-1 min-w-0 bg-gray-800 rounded px-2 py-0.5 text-xs text-gray-400 font-mono truncate">
            {url}
          </span>
          {isInspectMode && (
            <span className="text-[10px] text-blue-400 font-medium uppercase tracking-wider shrink-0">
              Inspect
            </span>
          )}
        </div>

        {bridgePath ? (
          <webview
            ref={webviewRef as React.Ref<HTMLElement>}
            src={url}
            preload={bridgePath}
            className="flex-1 w-full"
            style={{ border: 'none' }}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center bg-gray-950">
            <Loader2 className="w-5 h-5 text-gray-700 animate-spin" />
          </div>
        )}
      </div>
    )
  }
)
