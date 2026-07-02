import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Project, DevServerStatus, SelectedElement,
  WebviewElement, IpcMessageEvent, TextEditPayload, DomPatch
} from '../../types'
import { WelcomeScreen } from './WelcomeScreen'

export interface PreviewFrameHandle {
  clearInspector: () => void
  applyDomPatch: (patch: DomPatch) => void
  checkHbInjection: () => Promise<HbInjectionDiagnostic>
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
    { url, status, project, isInspectMode, bridgePath, onElementSelected, onPageNavigated, onTextSaved },
    ref
  ) {
    const webviewRef = useRef<WebviewElement>(null)
    const isReadyRef = useRef(false)
    // Stable ref so dom-ready handler always sees latest mode without re-registering
    const isInspectModeRef = useRef(isInspectMode)
    isInspectModeRef.current = isInspectMode

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

      function onStartLoading() {
        console.log('[preview] did-start-loading — clearing ready state')
        isReadyRef.current = false
        onPageNavigated()
      }

      function onDidNavigate() {
        console.log('[preview] did-navigate — full navigation')
        isReadyRef.current = false
      }

      function onDidNavigateInPage() {
        console.log('[preview] did-navigate-in-page — SPA navigation')
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
      webview.addEventListener('did-navigate', onDidNavigate)
      webview.addEventListener('did-navigate-in-page', onDidNavigateInPage)
      webview.addEventListener('ipc-message', onIpcMessage)

      return () => {
        webview.removeEventListener('dom-ready', onDomReady)
        webview.removeEventListener('did-start-loading', onStartLoading)
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
      <div className="flex-1 flex flex-col bg-gray-950 overflow-hidden">
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
