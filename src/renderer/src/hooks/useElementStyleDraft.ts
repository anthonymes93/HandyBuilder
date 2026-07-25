import { useCallback, useEffect, useRef, useState } from 'react'
import { SelectedElement, StyleProps, StyleState, DomPatch } from '../types'

function computeOriginal(element: SelectedElement): StyleProps {
  const c = element.computed
  return {
    fontFamily: c.fontFamily,
    fontSize: c.fontSize,
    fontWeight: c.fontWeight,
    lineHeight: c.lineHeight,
    letterSpacing: c.letterSpacing,
    textAlign: c.textAlign,
    textTransform: c.textTransform,
    textDecoration: c.textDecorationLine,
    color: c.color,
    backgroundColor: c.backgroundColor,
    borderColor: c.borderColor,
    borderWidth: c.borderTopWidth,
    borderStyle: c.borderStyle,
    borderTopLeftRadius: c.borderTopLeftRadius,
    borderTopRightRadius: c.borderTopRightRadius,
    borderBottomRightRadius: c.borderBottomRightRadius,
    borderBottomLeftRadius: c.borderBottomLeftRadius,
    paddingTop: c.paddingTop,
    paddingRight: c.paddingRight,
    paddingBottom: c.paddingBottom,
    paddingLeft: c.paddingLeft,
    marginTop: c.marginTop,
    marginRight: c.marginRight,
    marginBottom: c.marginBottom,
    marginLeft: c.marginLeft,
    width: c.width,
    minWidth: c.minWidth,
    height: c.height,
    display: c.display,
    justifyContent: c.justifyContent,
    alignItems: c.alignItems,
    opacity: c.opacity,
    boxShadow: c.boxShadow === 'none' ? '' : c.boxShadow,
    transform: c.transform === 'none' ? '' : c.transform,
    transitionDuration: c.transitionDuration,
  }
}

function elementKeyOf(element: SelectedElement): string {
  return `${element.hbSourceFile ?? ''}:${element.hbSourceLine ?? ''}:${element.tagName}`
}

export interface UseElementStyleDraftReturn {
  state: StyleState
  setState: (s: StyleState) => void
  /** Effective normal-state values (original merged with unsaved edits). */
  normal: StyleProps
  /** Only the hover-only overrides the user has set this session. */
  hover: Partial<StyleProps>
  /** The values the element had when first selected — used by per-property reset. */
  original: StyleProps
  dirty: boolean
  setNormalProp: (key: keyof StyleProps, value: string) => void
  setHoverProp: (key: keyof StyleProps, value: string) => void
  /** Reset one property in whichever state (Normal/Hover) is currently active. */
  resetProp: (key: keyof StyleProps) => void
  /** Reset every property in `keys` for the currently active state (used by "Reset section"). */
  resetSection: (keys: (keyof StyleProps)[]) => void
  /** Clear every draft change in both states. */
  resetAll: () => void
  /** Discard all unsaved changes and restore the live preview to its original appearance. */
  cancel: () => void
  /** Diff drafts against the original and return what Save should send — null if nothing changed. */
  buildSavePatch: () => { styleNormal: Partial<StyleProps>; styleHover: Partial<StyleProps> } | null
}

export function useElementStyleDraft(
  element: SelectedElement,
  onLivePatch: (patch: DomPatch) => void
): UseElementStyleDraftReturn {
  const [original, setOriginal] = useState<StyleProps>(() => computeOriginal(element))
  const [normalDraft, setNormalDraft] = useState<Partial<StyleProps>>({})
  const [hoverDraft, setHoverDraft] = useState<Partial<StyleProps>>({})
  const [state, setState] = useState<StyleState>('normal')

  const lastKeyRef = useRef<string | null>(null)

  // Only reset the draft when the SELECTED ELEMENT actually changes — not on
  // every re-collect that follows a live DOM patch (the bridge re-sends
  // `inspector:selected` after every patch, which would otherwise clobber
  // in-progress edits, e.g. mid-typed hex colour values).
  useEffect(() => {
    const key = elementKeyOf(element)
    if (lastKeyRef.current === key) return
    lastKeyRef.current = key
    setOriginal(computeOriginal(element))
    setNormalDraft({})
    setHoverDraft({})
    setState('normal')
  }, [element])

  const normal: StyleProps = { ...original, ...normalDraft }

  const dirty =
    Object.entries(normalDraft).some(([k, v]) => v !== (original as Record<string, string | undefined>)[k]) ||
    Object.values(hoverDraft).some((v) => v !== undefined && v !== '')

  // Live preview: push one full resolved style snapshot on every change.
  useEffect(() => {
    if (!dirty && state === 'normal') return
    const resolved = (state === 'hover' ? { ...normal, ...hoverDraft } : normal) as Record<string, string>
    onLivePatch({ styleProps: resolved })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, normalDraft, hoverDraft])

  const setNormalProp = useCallback((key: keyof StyleProps, value: string) => {
    setNormalDraft((prev) => ({ ...prev, [key]: value }))
  }, [])

  const setHoverProp = useCallback((key: keyof StyleProps, value: string) => {
    setHoverDraft((prev) => ({ ...prev, [key]: value }))
  }, [])

  const resetProp = useCallback((key: keyof StyleProps) => {
    if (state === 'hover') {
      setHoverDraft((prev) => { const next = { ...prev }; delete next[key]; return next })
    } else {
      setNormalDraft((prev) => { const next = { ...prev }; delete next[key]; return next })
    }
  }, [state])

  const resetSection = useCallback((keys: (keyof StyleProps)[]) => {
    if (state === 'hover') {
      setHoverDraft((prev) => {
        const next = { ...prev }
        for (const k of keys) delete next[k]
        return next
      })
    } else {
      setNormalDraft((prev) => {
        const next = { ...prev }
        for (const k of keys) delete next[k]
        return next
      })
    }
  }, [state])

  const resetAll = useCallback(() => {
    setNormalDraft({})
    setHoverDraft({})
  }, [])

  const cancel = useCallback(() => {
    setNormalDraft({})
    setHoverDraft({})
    setState('normal')
    onLivePatch({ clearStyleProps: true })
  }, [onLivePatch])

  const buildSavePatch = useCallback((): { styleNormal: Partial<StyleProps>; styleHover: Partial<StyleProps> } | null => {
    const styleNormal: Partial<StyleProps> = {}
    for (const [k, v] of Object.entries(normalDraft)) {
      if (v === undefined) continue
      if (v !== (original as Record<string, string | undefined>)[k]) {
        (styleNormal as Record<string, string>)[k] = v
      }
    }
    const styleHover: Partial<StyleProps> = {}
    for (const [k, v] of Object.entries(hoverDraft)) {
      if (v !== undefined && v !== '') (styleHover as Record<string, string>)[k] = v
    }
    if (Object.keys(styleNormal).length === 0 && Object.keys(styleHover).length === 0) return null
    return { styleNormal, styleHover }
  }, [normalDraft, hoverDraft, original])

  return {
    state, setState,
    normal, hover: hoverDraft, original,
    dirty,
    setNormalProp, setHoverProp,
    resetProp, resetSection, resetAll,
    cancel,
    buildSavePatch,
  }
}
