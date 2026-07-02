import { useRef, useState, useCallback, useEffect, useMemo } from 'react'
import { useProject } from './hooks/useProject'
import { useDevServer } from './hooks/useDevServer'
import { useTextEdit, buildElementKey } from './hooks/useTextEdit'
import { AppLayout } from './components/Layout/AppLayout'
import { SelectedElement, InspectorSavePatch, ImagePickResult, TextEditPayload, SourceMatch, DomPatch } from './types'
import type { PreviewFrameHandle } from './components/Preview/PreviewPanel'
import type { HbInjectionDiagnostic } from './components/Preview/PreviewPanel'

function App() {
  const { project, fileTree, isLoading, openProject } = useProject()
  const { url, status, logs } = useDevServer()

  // Lines from the dev server that contain HandyBuilder plugin diagnostics
  const hbLogs = useMemo(() => {
    const lines: string[] = []
    for (const chunk of logs) {
      for (const line of chunk.split('\n')) {
        if (line.includes('[hb-plugin]') || line.includes('[hb-config]') || line.includes('[handybuilder]')) {
          lines.push(line)
        }
      }
    }
    return lines.slice(-60)
  }, [logs])
  const {
    saveStatus,
    saveResult,
    pendingAnalysis,
    handleTextSaved,
    handleConfirmMatch,
    handleCancelConfirmation,
    handleManualCommit,
    retryLastSave,
    dismissSaveResult,
    reportDirectWrite,
  } = useTextEdit(project)

  const [isInspectMode, setIsInspectMode] = useState(false)
  const [selectedElement, setSelectedElement] = useState<SelectedElement | null>(null)
  const [bridgePath, setBridgePath] = useState<string | null>(null)
  const [locatorPayload, setLocatorPayload] = useState<TextEditPayload | null>(null)
  const [hbDiagnostic, setHbDiagnostic] = useState<HbInjectionDiagnostic | null>(null)
  const [hbDiagnosticError, setHbDiagnosticError] = useState<string | null>(null)

  const previewRef = useRef<PreviewFrameHandle>(null)

  useEffect(() => {
    window.api.getInspectorBridgePath().then(setBridgePath)
  }, [])

  const handleToggleInspect = useCallback(() => {
    setIsInspectMode((prev) => {
      if (prev) setSelectedElement(null)
      return !prev
    })
  }, [])

  const handleElementSelected = useCallback((el: SelectedElement) => {
    setSelectedElement(el)
  }, [])

  const handleClearSelection = useCallback(() => {
    setSelectedElement(null)
    previewRef.current?.clearInspector()
  }, [])

  const handlePageNavigated = useCallback(() => {
    setSelectedElement(null)
  }, [])

  const handleCheckHbInjection = useCallback(async () => {
    setHbDiagnostic(null)
    setHbDiagnosticError(null)
    try {
      setHbDiagnostic(await previewRef.current!.checkHbInjection())
    } catch (err) {
      setHbDiagnosticError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const handlePickFile = useCallback(async (): Promise<ImagePickResult | null> => {
    const result = await window.api.pickImageFile()
    if (!result || 'error' in result) {
      if (result && 'error' in result) console.warn('[app] image pick error:', result.error)
      return null
    }
    return result
  }, [])

  const handleOpenFile = useCallback((filePath: string) => {
    window.api.openFileInEditor(filePath).then((r) => {
      if ('error' in r) console.warn('[app] openFileInEditor error:', r.error)
    })
  }, [])

  const handleShowInFolder = useCallback((filePath: string) => {
    window.api.showInFolder(filePath)
  }, [])

  // Log every time locatorPayload changes so we can trace the routing
  useEffect(() => {
    console.log('[app] locatorPayload changed →', locatorPayload)
  }, [locatorPayload])

  // ── source locator ──────────────────────────────────────────────────────────

  const handleOpenSourceLocator = useCallback((payload: TextEditPayload) => {
    console.log('[app] handleOpenSourceLocator called, payload:', payload)
    if (!payload) {
      console.error('[app] handleOpenSourceLocator: payload is null/undefined — cannot open locator')
      return
    }
    setLocatorPayload(payload)
    console.log('[app] setLocatorPayload called')
    dismissSaveResult()
  }, [dismissSaveResult])

  const handleCloseSourceLocator = useCallback(() => {
    setLocatorPayload(null)
  }, [])

  const handleLocatorSave = useCallback(
    async (match: SourceMatch, newText: string) => {
      const result = await handleManualCommit(match, newText)

      if (result.success && result.filePath && project && locatorPayload) {
        // Save mapping so future edits to this element go directly to this file
        const key = buildElementKey(
          locatorPayload.tagName,
          locatorPayload.id,
          locatorPayload.classList
        )
        if (key && locatorPayload.oldText.trim()) {
          window.api.saveElementMapping({
            projectPath: project.path,
            mapping: {
              key,
              tagName:    locatorPayload.tagName,
              id:         locatorPayload.id ?? null,
              classList:  locatorPayload.classList ?? [],
              oldText:    locatorPayload.oldText.trim(),
              filePath:   result.filePath,
              lineNumber: result.lineNumber,
              lastUsed:   Date.now(),
            },
          }).catch((err: unknown) => console.warn('[app] saveElementMapping failed:', err))
        }

        setLocatorPayload(null)
      }

      return result
    },
    [handleManualCommit, project, locatorPayload]
  )

  // ── live DOM patch (no source save) ─────────────────────────────────────────

  const handleLivePatch = useCallback((patch: DomPatch) => {
    previewRef.current?.applyDomPatch(patch)
  }, [])

  // ── inspector save ──────────────────────────────────────────────────────────

  const handleInspectorSave = useCallback(
    async (patch: InspectorSavePatch) => {
      const el = patch.element

      // Apply changes to the live preview DOM immediately.
      previewRef.current?.applyDomPatch({
        text:               patch.text,
        href:               patch.href,
        disabled:           patch.disabled,
        imageSrc:           patch.imageSrc,
        imageAlt:           patch.imageAlt,
        imageWidth:         patch.imageWidth,
        imageHeight:        patch.imageHeight,
        objectFit:          patch.objectFit,
        objectPosition:     patch.objectPosition,
        backgroundImage:    patch.backgroundImage,
        backgroundSize:     patch.backgroundSize,
        backgroundPosition: patch.backgroundPosition,
        transform:          patch.transform,
      })

      // ── Image display-style save (new path) ────────────────────────────────
      // When source metadata is available, write a real inline style={{ }} prop
      // rather than using the fuzzy text-search pipeline.

      const hasStyleProps =
        patch.objectFit          !== undefined ||
        patch.objectPosition     !== undefined ||
        patch.transform          !== undefined ||
        patch.backgroundSize     !== undefined ||
        patch.backgroundPosition !== undefined ||
        patch.backgroundImage    !== undefined

      if (hasStyleProps && el.hbSourceFile && el.hbSourceLine) {
        const styleProps: Record<string, string> = {}

        if (el.tagName === 'img') {
          if (patch.objectFit      !== undefined) styleProps.objectFit      = patch.objectFit
          if (patch.objectPosition !== undefined) styleProps.objectPosition = patch.objectPosition
          // 'none' means "no zoom" — writeInlineStyle deletes the key when value is ''
          if (patch.transform !== undefined) {
            styleProps.transform = patch.transform === 'none' ? '' : patch.transform
          }
        } else {
          // Background element
          if (el.hbItemId && patch.backgroundImage !== undefined) {
            // Per-item image inside a mapped array — write to the data array item,
            // not the shared JSX style prop (which would change all mapped cards).
            const m = patch.backgroundImage.match(/url\(["']?([^"')]+)["']?\)/)
            if (m) {
              console.log('[app] writeArrayItemProp →', el.hbSourceFile, 'item', el.hbItemId, 'image:', m[1])
              const result = await window.api.writeArrayItemProp({
                filePath:  el.hbSourceFile,
                itemId:    el.hbItemId,
                propName:  'image',
                propValue: m[1],
              })
              reportDirectWrite(result)
            }
            // Skip writeInlineStyle — backgroundSize/backgroundPosition are sensible
            // defaults in the JSX template; writing them would affect all cards equally.
            return
          }
          if (patch.backgroundImage !== undefined) {
            const m = patch.backgroundImage.match(/url\(["']?([^"')]+)["']?\)/)
            if (m) styleProps.backgroundImage = `url("${m[1]}")`
          }
          if (patch.backgroundSize     !== undefined) styleProps.backgroundSize     = patch.backgroundSize
          if (patch.backgroundPosition !== undefined) styleProps.backgroundPosition = patch.backgroundPosition
          styleProps.backgroundRepeat = 'no-repeat'
        }

        if (Object.keys(styleProps).length > 0) {
          console.log('[app] writeInlineStyle →', el.hbSourceFile, 'line', el.hbSourceLine, styleProps)
          const result = await window.api.writeInlineStyle({
            filePath:   el.hbSourceFile,
            lineNumber: el.hbSourceLine,
            styleProps,
            tagName:    el.tagName,
          })
          reportDirectWrite(result)
        }

        // Attribute-level saves for img (src, alt, width, height) still go
        // through the text-search pipeline when there's no dedicated IPC for them.
        if (el.tagName === 'img') {
          type SavePair = { oldText: string; newText: string }
          const saves: SavePair[] = []
          function pushAttr(old: string | null | undefined, next: string | undefined) {
            if (next === undefined) return
            const o = (old ?? '').trim()
            const n = next.trim()
            if (n && n !== o) saves.push({ oldText: o, newText: n })
          }
          pushAttr(el.imageSrc, patch.imageSrc)
          pushAttr(el.imageAlt, patch.imageAlt)
          for (const { oldText, newText } of saves) {
            if (!oldText || !newText) continue
            await handleTextSaved({ tagName: el.tagName, oldText, newText })
          }
        }

        return
      }

      // ── Text / link / button / fallback saves (existing text-search path) ──

      type SavePair = { oldText: string; newText: string }
      const saves: SavePair[] = []

      function push(oldText: string | null | undefined, newText: string | undefined) {
        if (newText === undefined) return
        const o = (oldText ?? '').trim()
        const n = newText.trim()
        if (n && n !== o) saves.push({ oldText: o, newText: n })
      }

      push(el.textContent, patch.text)
      push(el.href,        patch.href)
      push(el.imageSrc,    patch.imageSrc)
      push(el.imageAlt,    patch.imageAlt)
      push(el.imageWidth,  patch.imageWidth)
      push(el.imageHeight, patch.imageHeight)
      // Fallback style saves (no source metadata)
      push(el.computed.objectFit,          patch.objectFit)
      push(el.computed.objectPosition,     patch.objectPosition)
      push(el.computed.backgroundSize,     patch.backgroundSize)
      push(el.computed.backgroundPosition, patch.backgroundPosition)
      if (patch.backgroundImage !== undefined) {
        const extractUrl = (v: string) => { const m = v.match(/url\(["']?([^"')]+)["']?\)/); return m ? m[1] : v }
        push(extractUrl(el.computed.backgroundImage ?? ''), extractUrl(patch.backgroundImage))
      }

      for (const { oldText, newText } of saves) {
        if (!oldText || !newText) continue
        const result = await handleTextSaved({ tagName: el.tagName, oldText, newText })
        if (result === 'needs-confirmation') return
      }
    },
    [handleTextSaved, reportDirectWrite]
  )

  return (
    <AppLayout
      project={project}
      fileTree={fileTree}
      isLoading={isLoading}
      devServerUrl={url}
      devServerStatus={status}
      hbLogs={hbLogs}
      isInspectMode={isInspectMode}
      selectedElement={selectedElement}
      bridgePath={bridgePath}
      previewRef={previewRef}
      saveStatus={saveStatus}
      saveResult={saveResult}
      pendingAnalysis={pendingAnalysis}
      locatorPayload={locatorPayload}
      hbDiagnostic={hbDiagnostic}
      hbDiagnosticError={hbDiagnosticError}
      onOpenProject={openProject}
      onReload={() => window.api.reloadPreview()}
      onOpenInBrowser={() => window.api.openInBrowser()}
      onToggleInspect={handleToggleInspect}
      onCheckHbInjection={handleCheckHbInjection}
      onCloseHbDiagnostic={() => { setHbDiagnostic(null); setHbDiagnosticError(null) }}
      onElementSelected={handleElementSelected}
      onClearSelection={handleClearSelection}
      onPageNavigated={handlePageNavigated}
      onTextSaved={handleTextSaved}
      onConfirmMatch={handleConfirmMatch}
      onCancelConfirmation={handleCancelConfirmation}
      onInspectorSave={handleInspectorSave}
      onPickFile={handlePickFile}
      onLivePatch={handleLivePatch}
      onRetryLastSave={retryLastSave}
      onOpenSourceLocator={handleOpenSourceLocator}
      onCloseSourceLocator={handleCloseSourceLocator}
      onLocatorSave={handleLocatorSave}
      onDismissSaveResult={dismissSaveResult}
      onOpenFile={handleOpenFile}
      onShowInFolder={handleShowInFolder}
    />
  )
}

export default App
