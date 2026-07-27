import { useCallback, useRef } from 'react'
import type { RefObject } from 'react'
import { PreviewFrameHandle, PreviewViewState, RestoreAck } from '../components/Preview/PreviewPanel'
import { SelectedElement } from '../types'
import { buildElementIdentity } from '../utils/elementIdentity'

export interface UsePreviewViewStateReturn {
  /** Snapshot scroll/route/selection just BEFORE a source write. */
  captureViewState: (selectedElement: SelectedElement | null) => Promise<PreviewViewState | null>
  /** Re-apply a capture AFTER a successful write, waiting for the actual reload (or Fast Refresh) to settle. */
  restoreViewState: (state: PreviewViewState | null) => Promise<RestoreAck | null>
  /** Call when the write FAILED — nothing was written, so no reload is coming; un-arm the expected-reload guard. */
  cancelPendingReload: () => void
}

let nextOperationSeq = 0

/**
 * Centralised preview scroll/selection preservation across a source-save-
 * triggered reload. Every save/undo/redo entry point in App.tsx follows the
 * same shape:
 *
 *   const viewState = await captureViewState(selectedElement)
 *   const success = await performTheWrite()
 *   if (success) await restoreViewState(viewState)
 *   else cancelPendingReload()
 *
 * captureViewState() arms PreviewPanel's "expect a reload" guard BEFORE
 * doing anything else — critically, before the caller writes the source
 * file. Vite's file watcher can react to that write, and the resulting
 * did-start-loading can fire, before our own await chain would otherwise
 * get around to arming the guard; arming it any later reintroduces the
 * exact race this hook exists to prevent.
 */
export function usePreviewViewState(previewRef: RefObject<PreviewFrameHandle>): UsePreviewViewStateReturn {
  const armedRef = useRef(false)

  const captureViewState = useCallback(
    async (selectedElement: SelectedElement | null): Promise<PreviewViewState | null> => {
      const operationId = `op-${Date.now().toString(36)}-${(nextOperationSeq++).toString(36)}`
      previewRef.current?.setExpectingReload(true, operationId)
      armedRef.current = true

      const base = await previewRef.current?.captureViewState()
      if (!base) {
        previewRef.current?.setExpectingReload(false)
        armedRef.current = false
        return null
      }
      return {
        ...base,
        identity: selectedElement ? buildElementIdentity(selectedElement) : null,
        operationId,
      }
    },
    [previewRef]
  )

  const restoreViewState = useCallback(
    async (state: PreviewViewState | null): Promise<RestoreAck | null> => {
      if (!state) return null
      try {
        return (await previewRef.current?.restoreViewState(state)) ?? null
      } finally {
        previewRef.current?.setExpectingReload(false)
        armedRef.current = false
      }
    },
    [previewRef]
  )

  const cancelPendingReload = useCallback(() => {
    if (!armedRef.current) return
    previewRef.current?.setExpectingReload(false)
    armedRef.current = false
  }, [previewRef])

  return { captureViewState, restoreViewState, cancelPendingReload }
}
