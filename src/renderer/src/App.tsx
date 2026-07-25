import { useRef, useState, useCallback, useEffect, useMemo } from 'react'
import { useProject } from './hooks/useProject'
import { useDevServer } from './hooks/useDevServer'
import { useTextEdit, buildElementKey } from './hooks/useTextEdit'
import { useEditHistory } from './hooks/useEditHistory'
import { AppLayout } from './components/Layout/AppLayout'
import { SelectedElement, InspectorSavePatch, ImagePickResult, TextEditPayload, SourceMatch, DomPatch, HistoryElementMeta } from './types'
import type { PreviewFrameHandle } from './components/Preview/PreviewPanel'
import type { HbInjectionDiagnostic } from './components/Preview/PreviewPanel'

function elementMeta(el: SelectedElement): HistoryElementMeta {
  return { tagName: el.tagName, id: el.id, classList: el.classList }
}

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
    pendingAstBindings,
    handleTextSaved,
    handleConfirmMatch,
    handleCancelConfirmation,
    handleConfirmAstBinding,
    handleCancelAstPicker,
    handleManualCommit,
    retryLastSave,
    dismissSaveResult,
    reportDirectWrite,
  } = useTextEdit(project)

  const {
    historyState,
    undo: undoHistory,
    redo: redoHistory,
    refresh: refreshHistory,
    conflict: historyConflict,
    dismissConflict: dismissHistoryConflict,
    discardConflictFileHistory,
    notice: historyNotice,
    dismissNotice: dismissHistoryNotice,
  } = useEditHistory(project)

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

  // Refresh the undo/redo stacks whenever a save completes — every source
  // writer (text, image, link, style, AST binding, manual edit) funnels
  // through applySourceTransaction in the main process and records history
  // automatically, so the renderer just needs to re-fetch the latest state.
  useEffect(() => {
    if (saveStatus === 'saved') refreshHistory()
  }, [saveStatus, saveResult, refreshHistory])

  // Keyboard shortcuts: Ctrl+Z (Undo), Ctrl+Shift+Z / Ctrl+Y (Redo).
  // Cmd on macOS. Ignored while typing in a text input/textarea/contenteditable
  // in the host UI; the <webview> preview has its own isolated key handling.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return

      if (e.key.toLowerCase() === 'z' && e.shiftKey) {
        e.preventDefault()
        redoHistory()
      } else if (e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undoHistory()
      } else if (e.key.toLowerCase() === 'y') {
        e.preventDefault()
        redoHistory()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undoHistory, redoHistory])

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
      const projectPath = project?.path

      // Apply changes to the live preview DOM immediately.
      previewRef.current?.applyDomPatch({
        text:               patch.text,
        href:               patch.href,
        linkTarget:         patch.linkTarget,
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

      // ── Visual Button/Text style editor save ────────────────────────────────
      // Normal styles merge into style={{}} (Tailwind-safe-subset reconciled);
      // hover styles attach a stable class + write to a shared stylesheet.
      // Both files land in ONE atomic multi-file transaction — one Undo step.
      if (patch.styleNormal || patch.styleHover) {
        if (!projectPath || !el.hbSourceFile || !el.hbSourceLine) {
          reportDirectWrite({ success: false, error: 'No source location found for this element — cannot save style to file.' })
          return
        }
        console.log('[app] writeElementStyle →', el.hbSourceFile, 'line', el.hbSourceLine, patch.styleNormal, patch.styleHover)
        const result = await window.api.writeElementStyle({
          filePath: el.hbSourceFile,
          lineNumber: el.hbSourceLine,
          tagName: el.tagName,
          normalStyleProps: (patch.styleNormal ?? {}) as Record<string, string>,
          hoverStyleProps: patch.styleHover as Record<string, string> | undefined,
          projectPath,
          description: patch.styleDescription ?? 'Changed element style',
          element: elementMeta(el),
        })
        if (result.hoverWarning) console.warn('[app] hover style warning:', result.hoverWarning)
        reportDirectWrite(
          result.success
            ? { success: true, filePath: result.filePath, lineNumber: result.lineNumber }
            : { success: false, error: result.error }
        )
        return
      }

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
        if (!projectPath) {
          reportDirectWrite({ success: false, error: 'No project open — cannot save to file.' })
          return
        }

        const styleProps: Record<string, string> = {}
        type WriteOutcome = { success: boolean; filePath?: string; lineNumber?: number; error?: string }
        const outcomes: WriteOutcome[] = []
        const meta = elementMeta(el)

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
                filePath:    el.hbSourceFile,
                itemId:      el.hbItemId,
                propName:    'image',
                propValue:   m[1],
                projectPath,
                description: 'Replaced background image',
                editType:    'image',
                element:     meta,
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
          // Describe what the user actually changed so the history entry reads
          // naturally (e.g. "Changed image focal point" rather than "Changed style").
          let description = 'Changed image style'
          let editType: 'style' | 'image' = 'style'
          if (el.tagName === 'img') {
            const fitChanged  = patch.objectFit      !== undefined && patch.objectFit      !== el.computed.objectFit
            const posChanged  = patch.objectPosition !== undefined && patch.objectPosition !== el.computed.objectPosition
            const zoomChanged = patch.transform      !== undefined && patch.transform      !== el.computed.transform
            if (posChanged && !fitChanged && !zoomChanged) description = 'Changed image focal point'
            else if (zoomChanged && !posChanged && !fitChanged) description = 'Changed image zoom'
            else if (fitChanged && !posChanged && !zoomChanged) description = 'Changed image fit'
          } else {
            editType = 'image'
            description = patch.backgroundImage !== undefined ? 'Replaced background image' : 'Changed background style'
          }

          console.log('[app] writeInlineStyle →', el.hbSourceFile, 'line', el.hbSourceLine, styleProps)
          const result = await window.api.writeInlineStyle({
            filePath:   el.hbSourceFile,
            lineNumber: el.hbSourceLine,
            styleProps,
            tagName:    el.tagName,
            projectPath,
            description,
            editType,
            element: meta,
          })
          outcomes.push(result)
        }

        // ── <img> attribute save (src/alt/width/height) ────────────────────
        // Images have no visible text to search for — the fuzzy text-search
        // pipeline (handleTextSaved / analyzeLocatedEdit / AST text binding
        // resolver) must never be used here. Parse the file with Babel and
        // write the exact attribute spans instead.
        if (el.tagName === 'img') {
          const attrs: { src?: string; alt?: string; width?: string; height?: string } = {}
          const setAttr = (
            key: 'src' | 'alt' | 'width' | 'height',
            old: string | null | undefined,
            next: string | undefined
          ) => {
            if (next === undefined) return
            const o = (old ?? '').trim()
            const n = next.trim()
            if (n && n !== o) attrs[key] = n
          }
          setAttr('src',    el.imageSrc,    patch.imageSrc)
          setAttr('alt',    el.imageAlt,    patch.imageAlt)
          setAttr('width',  el.imageWidth,  patch.imageWidth)
          setAttr('height', el.imageHeight, patch.imageHeight)

          if (Object.keys(attrs).length > 0) {
            let description = 'Updated image'
            if (attrs.src !== undefined) description = 'Replaced image'
            else if (attrs.alt !== undefined) description = 'Updated image alt text'
            else if (attrs.width !== undefined || attrs.height !== undefined) description = 'Resized image'

            console.log('[app] writeImageAttrs →', el.hbSourceFile, 'line', el.hbSourceLine, attrs)
            const result = await window.api.writeImageAttrs({
              filePath:   el.hbSourceFile,
              lineNumber: el.hbSourceLine,
              tagName:    el.tagName,
              ...attrs,
              projectPath,
              description,
              editType: 'image',
              element: meta,
            })
            outcomes.push(result)
          }
        }

        // Report one combined result so a failed write is never masked by an
        // earlier successful one (e.g. style saved but src attribute failed).
        // Only a verified successful file write shows "Saved" — the live DOM
        // patch above already ran unconditionally and does not affect this.
        if (outcomes.length > 0) {
          const failed = outcomes.find((o) => !o.success)
          if (failed) {
            reportDirectWrite({ success: false, error: failed.error ?? 'Image save failed' })
          } else {
            const last = outcomes[outcomes.length - 1]
            reportDirectWrite({ success: true, filePath: last.filePath, lineNumber: last.lineNumber })
          }
        }

        return
      }

      // ── Href save for mapped array card links ────────────────────────────────
      // Card-level <a> elements carry hbItemId from data-hb-item-id={project.name}.
      // Their href is the per-item `url` field in the data array — update only that
      // item rather than running a project-wide text search.
      if (patch.href !== undefined && el.hbItemId && el.hbSourceFile) {
        const oldHref = (el.href ?? '').trim()
        const newHref = patch.href.trim()
        if (oldHref && newHref && newHref !== oldHref) {
          if (!projectPath) {
            reportDirectWrite({ success: false, error: 'No project open — cannot save to file.' })
            return
          }
          console.log('[app] updateArrayItemText for href →', el.hbSourceFile, 'item', el.hbItemId)
          const result = await window.api.updateArrayItemText({
            filePath: el.hbSourceFile,
            itemId:   el.hbItemId,
            oldText:  oldHref,
            newText:  newHref,
            projectPath,
            description: 'Updated button URL',
            editType: 'link',
            element: elementMeta(el),
          })
          reportDirectWrite(result)
        }
        return
      }

      // ── Text / link / button / fallback saves (existing text-search path) ──

      // Image/background edits must never go through the fuzzy text-search
      // pipeline. If we got here, hasStyleProps is true (this is an image or
      // background-image edit) but el.hbSourceFile/hbSourceLine is missing,
      // so there is no reliable location to write to at all.
      if (hasStyleProps) {
        reportDirectWrite({
          success: false,
          error: 'No source location found for this image — cannot save to file.',
        })
        return
      }

      type SavePair = { oldText: string; newText: string; editKind: 'text' | 'href' }
      const saves: SavePair[] = []

      function push(oldText: string | null | undefined, newText: string | undefined, editKind: 'text' | 'href') {
        if (newText === undefined) return
        const o = (oldText ?? '').trim()
        const n = newText.trim()
        if (n && n !== o) saves.push({ oldText: o, newText: n, editKind })
      }

      push(el.textContent, patch.text, 'text')
      push(el.href,        patch.href, 'href')

      for (const { oldText, newText, editKind } of saves) {
        if (!oldText || !newText) continue
        const result = await handleTextSaved({
          tagName:    el.tagName,
          oldText,
          newText,
          sourceFile: el.hbSourceFile ?? undefined,
          sourceLine: el.hbSourceLine ?? undefined,
          sourceCol:  el.hbSourceCol  ?? undefined,
          id:         el.id ?? undefined,
          classList:  el.classList,
          editKind,
        })
        if (result === 'needs-confirmation') return
      }
    },
    [handleTextSaved, reportDirectWrite, project]
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
      pendingAstBindings={pendingAstBindings}
      locatorPayload={locatorPayload}
      hbDiagnostic={hbDiagnostic}
      hbDiagnosticError={hbDiagnosticError}
      historyState={historyState}
      historyNotice={historyNotice}
      historyConflict={historyConflict}
      onOpenProject={openProject}
      onUndo={undoHistory}
      onRedo={redoHistory}
      onDismissHistoryNotice={dismissHistoryNotice}
      onDismissHistoryConflict={dismissHistoryConflict}
      onDiscardConflictFileHistory={discardConflictFileHistory}
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
      onConfirmAstBinding={handleConfirmAstBinding}
      onCancelAstPicker={handleCancelAstPicker}
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
