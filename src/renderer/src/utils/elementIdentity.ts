import { SelectedElement } from '../types'

/**
 * Enough about a selected element to re-locate its equivalent DOM node after
 * a save-triggered reload, tried in priority order by the bridge:
 * hb-style-id → source file/line/col → hbItemId → id → href+text → tag/class/text.
 */
export interface ElementIdentity {
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

export function buildElementIdentity(el: SelectedElement): ElementIdentity {
  return {
    hbStyleId: el.hbStyleId ?? null,
    sourceFile: el.hbSourceFile ?? null,
    sourceLine: el.hbSourceLine ?? null,
    sourceCol: el.hbSourceCol ?? null,
    hbItemId: el.hbItemId ?? null,
    id: el.id ?? null,
    tagName: el.tagName ?? null,
    classList: el.classList,
    textPreview: el.textContent ?? null,
    href: el.href ?? null,
  }
}
