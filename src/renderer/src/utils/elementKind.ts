import { SelectedElement } from '../types'

export type ElementKind = 'text' | 'button' | 'link' | 'image' | 'container'

const TEXT_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'span', 'li', 'dt', 'dd', 'td', 'th',
  'label', 'caption', 'blockquote', 'figcaption'
])

const BUTTON_INPUT_TYPES = new Set(['button', 'submit', 'reset'])

export function classifyElement(el: SelectedElement): ElementKind {
  const tag = el.tagName

  if (tag === 'img' || tag === 'picture' || tag === 'svg') return 'image'

  if (tag === 'button') return 'button'

  if (tag === 'input' && el.inputType && BUTTON_INPUT_TYPES.has(el.inputType)) return 'button'

  if (tag === 'a') {
    const isButtonRole = el.role === 'button'
    const hasButtonClass = el.classList.some((c) => /\bbtn\b|button/i.test(c))
    return isButtonRole || hasButtonClass ? 'button' : 'link'
  }

  // Element with a CSS background-image (div, section, etc.)
  if (
    el.computed.backgroundImage &&
    el.computed.backgroundImage !== 'none' &&
    el.computed.backgroundImage !== ''
  ) {
    return 'image'
  }

  if (TEXT_TAGS.has(tag)) return 'text'

  return 'container'
}

export function isEditable(el: SelectedElement): boolean {
  const kind = classifyElement(el)
  return kind === 'button' || kind === 'link' || kind === 'image'
}
