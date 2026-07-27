import { useRef, useState, useCallback, useEffect, useMemo } from 'react'
import { useProject } from './hooks/useProject'
import { useDevServer } from './hooks/useDevServer'
import { useTextEdit, buildElementKey } from './hooks/useTextEdit'
import { useEditHistory } from './hooks/useEditHistory'
import { usePreviewViewState } from './hooks/usePreviewViewState'
import { AppLayout } from './components/Layout/AppLayout'
import { SelectedElement, InspectorSavePatch, ImagePickResult, TextEditPayload, SourceMatch, DomPatch, HistoryElementMeta, StyleScopeChoice } from './types'
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
    handleTextSaved: handleTextSavedRaw,
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
  const [pendingScopeChoice, setPendingScopeChoice] = useState<{ patch: InspectorSavePatch; choice: StyleScopeChoice } | null>(null)

  const previewRef = useRef<PreviewFrameHandle>(null)

  // ── preview view-state (scroll/route/selection) preservation ───────────────
  // Every save/undo/redo entry point captures before writing and restores
  // after — see usePreviewViewState.ts for the capture→write→restore shape
  // and PreviewPanel.tsx for the retry/ack mechanics.
  const { captureViewState, restoreViewState, cancelPendingReload } = usePreviewViewState(previewRef)

  const restoreAfterSave = useCallback(
    async (viewState: Awaited<ReturnType<typeof captureViewState>>) => {
      const ack = await restoreViewState(viewState)
      // Retried the full ~1.5s budget and the element genuinely isn't there
      // anymore (as opposed to the bridge never responding at all) — only
      // then is it correct to close the Inspector.
      if (ack && !ack.success && viewState?.identity) setSelectedElement(null)
    },
    [restoreViewState]
  )

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

  // Undo/Redo wrapped with view-state preservation — same capture → act →
  // restore shape as saves. `undoHistory`/`redoHistory` themselves stay
  // available unwrapped for the internal isolation-check rollback inside
  // performInspectorSave (an automatic safety net mid-failing-save, not a
  // user-initiated action — it shouldn't trigger its own capture/restore).
  const handleUndo = useCallback(async () => {
    const viewState = await captureViewState(selectedElement)
    await undoHistory()
    await restoreAfterSave(viewState)
  }, [captureViewState, restoreAfterSave, undoHistory, selectedElement])

  const handleRedo = useCallback(async () => {
    const viewState = await captureViewState(selectedElement)
    await redoHistory()
    await restoreAfterSave(viewState)
  }, [captureViewState, restoreAfterSave, redoHistory, selectedElement])

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
        handleRedo()
      } else if (e.key.toLowerCase() === 'z') {
        e.preventDefault()
        handleUndo()
      } else if (e.key.toLowerCase() === 'y') {
        e.preventDefault()
        handleRedo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleUndo, handleRedo])

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

  // Poll the live preview for how many elements carry a just-written style
  // class. Stops as soon as at least one match appears (HMR lands as one
  // atomic re-render, so the first non-zero reading is the final one) or
  // after ~3s if the preview never picks up the change.
  const waitForClassCount = useCallback(async (className: string): Promise<number> => {
    const selector = `.${className}`
    const deadline = Date.now() + 3000
    let last = 0
    while (Date.now() < deadline) {
      last = (await previewRef.current?.countMatchingElements(selector)) ?? -1
      if (last > 0) return last
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return last
  }, [])

  // Poll the live preview until it confirms the just-saved background-image
  // URL actually made it into the rendered page (i.e. Vite HMR landed the
  // file change) — or ~3s times out. `null` (owner element/rule not found)
  // is treated as inconclusive, never as a failure.
  const waitForBackgroundVerified = useCallback(
    async (params: Parameters<PreviewFrameHandle['verifyBackgroundImage']>[0]): Promise<boolean | null> => {
      const deadline = Date.now() + 3000
      let last: boolean | null = null
      while (Date.now() < deadline) {
        last = (await previewRef.current?.verifyBackgroundImage(params)) ?? null
        if (last === true) return true
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      return last
    },
    []
  )

  // ── inspector save ──────────────────────────────────────────────────────────

  const performInspectorSave = useCallback(
    async (patch: InspectorSavePatch): Promise<boolean> => {
      const el = patch.element
      const projectPath = project?.path

      // A resolved pseudo-element (::before/::after) image owner has no DOM
      // node the bridge can redirect an inline-style patch to — applying one
      // would land (wrongly) on the selected/overlay element itself. Skip the
      // live DOM patch entirely for that case; the preview picks up the real
      // change once Save completes and Vite HMR re-renders the stylesheet.
      const isPseudoOwner = patch.imageOwnerSourceType === 'pseudo-before' || patch.imageOwnerSourceType === 'pseudo-after'

      // Apply changes to the live preview DOM immediately.
      previewRef.current?.applyDomPatch({
        text:               patch.text,
        href:               patch.href,
        linkTarget:         patch.linkTarget,
        disabled:           patch.disabled,
        imageSrc:           isPseudoOwner ? undefined : patch.imageSrc,
        imageAlt:           patch.imageAlt,
        imageWidth:         patch.imageWidth,
        imageHeight:        patch.imageHeight,
        objectFit:          patch.objectFit,
        objectPosition:     patch.objectPosition,
        backgroundImage:    isPseudoOwner ? undefined : patch.backgroundImage,
        backgroundSize:     patch.backgroundSize,
        backgroundPosition: patch.backgroundPosition,
        transform:          patch.transform,
      })

      // ── Background-image OWNER save — resolved separately from the
      // selected/clicked element (e.g. selected = a translucent overlay div,
      // the real image lives on the section/img/pseudo-element behind it).
      // Routes the write to the owner's own source location instead of the
      // selected element's, then verifies the live preview actually picked
      // up the change after Vite HMR before reporting Saved.
      if (patch.imageOwnerSourceType && patch.imageOwnerFile) {
        if (!projectPath) {
          reportDirectWrite({ success: false, error: 'No project open — cannot save to file.' })
          return false
        }
        const newUrl = (patch.imageSrc ?? '').trim()
        if (!newUrl) {
          reportDirectWrite({ success: false, error: 'No image URL to save.' })
          return false
        }

        const ownerFile = patch.imageOwnerFile
        const ownerLine = patch.imageOwnerLine ?? undefined
        const ownerTag  = patch.imageOwnerTagName ?? undefined
        const meta = elementMeta(el)
        const description = 'Replaced background image'

        type WriteOutcome = { success: boolean; filePath?: string; lineNumber?: number; error?: string }
        let result: WriteOutcome

        if (patch.imageOwnerSourceType === 'img-tag') {
          if (ownerLine === undefined) {
            reportDirectWrite({ success: false, error: 'Could not determine the source location of the image owner.' })
            return false
          }
          console.log('[app] image-owner save → writeImageAttrs', { ownerFile, ownerLine, ownerTag, newUrl })
          result = await window.api.writeImageAttrs({
            filePath: ownerFile, lineNumber: ownerLine, tagName: ownerTag,
            src: newUrl, projectPath, description, editType: 'image', element: meta,
          })
        } else if (patch.imageOwnerSourceType === 'inline-style-url') {
          if (ownerLine === undefined) {
            reportDirectWrite({ success: false, error: 'Could not determine the source location of the image owner.' })
            return false
          }
          const styleProps: Record<string, string> = { backgroundImage: `url("${newUrl}")` }
          if (patch.backgroundSize     !== undefined) styleProps.backgroundSize     = patch.backgroundSize
          if (patch.backgroundPosition !== undefined) styleProps.backgroundPosition = patch.backgroundPosition
          console.log('[app] image-owner save → writeInlineStyle', { ownerFile, ownerLine, ownerTag, styleProps })
          result = await window.api.writeInlineStyle({
            filePath: ownerFile, lineNumber: ownerLine, styleProps, tagName: ownerTag,
            projectPath, description, editType: 'image', element: meta,
          })
        } else if (patch.imageOwnerSourceType === 'tailwind-arbitrary-url') {
          if (ownerLine === undefined) {
            reportDirectWrite({ success: false, error: 'Could not determine the source location of the image owner.' })
            return false
          }
          console.log('[app] image-owner save → writeTailwindBgUrl', { ownerFile, ownerLine, ownerTag, newUrl })
          result = await window.api.writeTailwindBgUrl({
            filePath: ownerFile, lineNumber: ownerLine, colNumber: patch.imageOwnerCol ?? undefined, tagName: ownerTag,
            newUrl, projectPath, description, editType: 'image', element: meta,
          })
        } else {
          // 'css-class-url' | 'pseudo-before' | 'pseudo-after'
          if (!patch.imageOwnerCssSelector) {
            reportDirectWrite({
              success: false,
              error: 'Could not determine the CSS rule for this background image — edit it in source.',
            })
            return false
          }
          console.log('[app] image-owner save → writeCssBackgroundImage', { ownerFile, selector: patch.imageOwnerCssSelector, newUrl })
          result = await window.api.writeCssBackgroundImage({
            filePath: ownerFile, selectorText: patch.imageOwnerCssSelector, newUrl,
            projectPath, description, editType: 'image', element: meta,
          })
        }

        if (!result.success) {
          console.log('[app] image-owner save → writer failed:', result.error)
          reportDirectWrite({ success: false, error: result.error })
          return false
        }

        const mode =
          patch.imageOwnerSourceType === 'img-tag' ? 'img-src' :
          patch.imageOwnerSourceType === 'pseudo-before' ? 'pseudo-before' :
          patch.imageOwnerSourceType === 'pseudo-after' ? 'pseudo-after' :
          'bg-image'
        const verified = await waitForBackgroundVerified({
          file: ownerFile,
          line: ownerLine ?? null,
          cssSelector: patch.imageOwnerCssSelector ?? null,
          mode,
          expectedUrlFragment: newUrl,
        })
        console.log('[app] image-owner save → post-save verification:', verified, '(file:', ownerFile, 'line:', ownerLine, ')')
        if (verified === false) {
          reportDirectWrite({
            success: false,
            error: `Preview updated, but ${ownerFile}${ownerLine ? `:${ownerLine}` : ''} was not confirmed to contain the new background-image source.`,
          })
          return false
        }

        reportDirectWrite({ success: true, filePath: result.filePath, lineNumber: result.lineNumber })
        return true
      }

      // ── Visual Button/Text style editor save ────────────────────────────────
      // Normal styles merge into style={{}} (Tailwind-safe-subset reconciled);
      // hover styles attach a stable class + write to a shared stylesheet.
      // Both files land in ONE atomic multi-file transaction — one Undo step.
      if (patch.styleNormal || patch.styleHover) {
        if (!projectPath || !el.hbSourceFile || !el.hbSourceLine) {
          reportDirectWrite({ success: false, error: 'No source location found for this element — cannot save style to file.' })
          return false
        }
        console.log('[app] writeElementStyle →', el.hbSourceFile, 'line', el.hbSourceLine, patch.styleNormal, patch.styleHover)
        const result = await window.api.writeElementStyle({
          filePath: el.hbSourceFile,
          lineNumber: el.hbSourceLine,
          colNumber: el.hbSourceCol ?? undefined,
          tagName: el.tagName,
          textContent: el.textContent ?? undefined,
          href: el.href ?? undefined,
          classList: el.classList,
          pathname: el.pathname ?? undefined,
          itemId: el.hbItemId ?? undefined,
          normalStyleProps: (patch.styleNormal ?? {}) as Record<string, string>,
          hoverStyleProps: patch.styleHover as Record<string, string> | undefined,
          projectPath,
          description: patch.styleDescription ?? 'Changed element style',
          element: elementMeta(el),
          editScope: patch.styleEditScope,
          scopeFilePath: patch.styleScopeFilePath,
          scopeLine: patch.styleScopeLine,
        })

        if (result.needsScopeChoice) {
          console.log('[app] writeElementStyle → needs scope choice', result.needsScopeChoice)
          setPendingScopeChoice({
            patch,
            choice: {
              ...result.needsScopeChoice,
              identityText: el.textContent,
              identityHref: el.href,
              identityItemId: el.hbItemId,
            },
          })
          return false
        }

        if (result.hoverWarning) console.warn('[app] hover style warning:', result.hoverWarning)
        if (result.sharedComponentWarning) console.warn('[app] shared component warning:', result.sharedComponentWarning)

        if (!result.success && result.diagnostics) {
          const top = result.diagnostics.candidates.slice(0, 3)
            .map((c) => `<${c.tagName}> line ${c.line} (${c.confidence}%)`)
            .join(', ')
          reportDirectWrite({
            success: false,
            error: top ? `${result.error} — top candidates: ${top}` : result.error,
          })
          return false
        }

        // ── Post-save isolation check ────────────────────────────────────────
        // "This button only" must change exactly one element. Poll the live
        // preview for the class we just wrote; if it landed on more than one
        // DOM node, the edit wasn't actually isolated — roll the whole
        // transaction back rather than leave a mis-scoped style in place.
        if (result.success && patch.styleEditScope === 'instance' && result.appliedClassName) {
          const count = await waitForClassCount(result.appliedClassName)
          if (count > 1) {
            console.warn('[app] instance style was not isolated — rolling back. matches:', count)
            await undoHistory()
            reportDirectWrite({
              success: false,
              error: 'Instance style was not isolated; changes were rolled back.',
            })
            return false
          }
          if (count === 0) {
            console.warn('[app] instance style isolation check inconclusive (no matches yet) — showing Saved')
          }
        }

        reportDirectWrite(
          result.success
            ? { success: true, filePath: result.filePath, lineNumber: result.lineNumber }
            : { success: false, error: result.error }
        )
        return result.success
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
          return false
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
            if (!m) return false
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
            // Skip writeInlineStyle — backgroundSize/backgroundPosition are sensible
            // defaults in the JSX template; writing them would affect all cards equally.
            return result.success
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
            return false
          }
          const last = outcomes[outcomes.length - 1]
          reportDirectWrite({ success: true, filePath: last.filePath, lineNumber: last.lineNumber })
        }

        return true
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
            return false
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
          return result.success
        }
        return true
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
        return false
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
        const result = await handleTextSavedRaw({
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
        if (result === 'needs-confirmation') return false
      }
      return true
    },
    [handleTextSavedRaw, reportDirectWrite, project, waitForClassCount, waitForBackgroundVerified, undoHistory]
  )

  // Wraps performInspectorSave with view-state capture/restore — this is the
  // one actually handed to the Inspector, keeping the save logic itself free
  // of scroll/selection bookkeeping.
  const handleInspectorSave = useCallback(
    async (patch: InspectorSavePatch): Promise<boolean> => {
      const viewState = await captureViewState(selectedElement)
      const success = await performInspectorSave(patch)
      if (success) await restoreAfterSave(viewState)
      else cancelPendingReload() // nothing was written — no reload is coming, un-arm the guard
      return success
    },
    [captureViewState, restoreAfterSave, cancelPendingReload, performInspectorSave, selectedElement]
  )

  // Wraps useTextEdit's handleTextSaved (used directly by the bridge's
  // double-click inline-edit flow) the same way.
  const handleTextSaved = useCallback(
    async (payload: TextEditPayload) => {
      const viewState = await captureViewState(selectedElement)
      const status = await handleTextSavedRaw(payload)
      if (status === 'saved') await restoreAfterSave(viewState)
      else cancelPendingReload() // dom-only/needs-confirmation/failed — no file was written
      return status
    },
    [captureViewState, restoreAfterSave, cancelPendingReload, handleTextSavedRaw, selectedElement]
  )

  // ── style-editor scope choice ("this button only" vs "all buttons using X") ─

  const handleChooseScope = useCallback(
    (scope: 'instance' | 'shared') => {
      if (!pendingScopeChoice) return
      const { patch, choice } = pendingScopeChoice
      setPendingScopeChoice(null)
      handleInspectorSave({
        ...patch,
        styleEditScope: scope,
        styleScopeFilePath: scope === 'shared' ? choice.sharedFilePath : undefined,
        styleScopeLine: scope === 'shared' ? choice.sharedLine : undefined,
      })
    },
    [pendingScopeChoice, handleInspectorSave]
  )

  const handleCancelScopeChoice = useCallback(() => {
    setPendingScopeChoice(null)
  }, [])

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
      pendingScopeChoice={pendingScopeChoice?.choice ?? null}
      onChooseScope={handleChooseScope}
      onCancelScopeChoice={handleCancelScopeChoice}
      onOpenProject={openProject}
      onUndo={handleUndo}
      onRedo={handleRedo}
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
