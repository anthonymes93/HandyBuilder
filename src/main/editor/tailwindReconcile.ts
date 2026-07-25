/**
 * Conservative Tailwind utility reconciliation.
 *
 * When the visual style editors set an inline style for a property (e.g.
 * backgroundColor), any existing Tailwind utility class that would visually
 * conflict for the *default* (unprefixed, non-responsive, non-dark, non-hover)
 * state is removed — so the class list doesn't accumulate dead/misleading
 * utilities. Variant-prefixed classes (`hover:bg-red-500`, `md:bg-red-500`,
 * `dark:bg-red-500`, `focus:...`) are NEVER touched here.
 *
 * This only recognises a curated, unambiguous subset per property, matched
 * against the WHOLE class token (not a substring) to avoid ever mangling an
 * unrelated utility. Anything not confidently recognised (arbitrary theme
 * tokens, classes built by a helper like `clsx(...)`) is left alone — the
 * inline style always wins visually (inline > any class selector), so
 * correctness never depends on stripping succeeding. This is best-effort
 * cleanup, not a requirement for the edit to be visually correct.
 */

const COLOR = '(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white|transparent|current)'
const ARBITRARY = '\\[[^\\]]+\\]'

/** One full-token matcher per StyleProps key we're willing to reconcile. */
const RULES: Record<string, RegExp> = {
  backgroundColor: new RegExp(`^bg-(?:${COLOR}(?:-\\d{2,3})?|${ARBITRARY})$`),
  color: new RegExp(`^text-(?:${COLOR}(?:-\\d{2,3})?|${ARBITRARY})$`),
  borderColor: new RegExp(`^border-(?:${COLOR}(?:-\\d{2,3})?|${ARBITRARY})$`),
  borderRadius: new RegExp(`^rounded(?:-(?:none|sm|md|lg|xl|2xl|3xl|full|${ARBITRARY}))?$`),
  borderWidth: new RegExp(`^border(?:-(?:0|2|4|8|${ARBITRARY}))?$`),
  borderStyle: /^border-(?:solid|dashed|dotted|double|none)$/,
  paddingTop: new RegExp(`^(?:p|py|pt)-(?:\\d+(?:\\.\\d+)?|px|${ARBITRARY})$`),
  paddingRight: new RegExp(`^(?:p|px|pr)-(?:\\d+(?:\\.\\d+)?|px|${ARBITRARY})$`),
  paddingBottom: new RegExp(`^(?:p|py|pb)-(?:\\d+(?:\\.\\d+)?|px|${ARBITRARY})$`),
  paddingLeft: new RegExp(`^(?:p|px|pl)-(?:\\d+(?:\\.\\d+)?|px|${ARBITRARY})$`),
  marginTop: new RegExp(`^(?:m|my|mt)-(?:\\d+(?:\\.\\d+)?|px|auto|${ARBITRARY})$`),
  marginRight: new RegExp(`^(?:m|mx|mr)-(?:\\d+(?:\\.\\d+)?|px|auto|${ARBITRARY})$`),
  marginBottom: new RegExp(`^(?:m|my|mb)-(?:\\d+(?:\\.\\d+)?|px|auto|${ARBITRARY})$`),
  marginLeft: new RegExp(`^(?:m|mx|ml)-(?:\\d+(?:\\.\\d+)?|px|auto|${ARBITRARY})$`),
  width: new RegExp(`^w-(?:\\d+(?:\\.\\d+)?|px|full|auto|screen|min|max|fit|\\d+/\\d+|${ARBITRARY})$`),
  minWidth: new RegExp(`^min-w-(?:\\d+|px|full|min|max|fit|${ARBITRARY})$`),
  height: new RegExp(`^h-(?:\\d+(?:\\.\\d+)?|px|full|auto|screen|min|max|fit|${ARBITRARY})$`),
  opacity: /^opacity-\d{1,3}$/,
  boxShadow: new RegExp(`^shadow(?:-(?:sm|md|lg|xl|2xl|inner|none|${ARBITRARY}))?$`),
  display: /^(?:inline-flex|flex|block|inline-block|inline|grid|hidden)$/,
  justifyContent: /^justify-(?:start|end|center|between|around|evenly)$/,
  alignItems: /^items-(?:start|end|center|baseline|stretch)$/,
  fontSize: /^text-(?:xs|sm|base|lg|xl|\d?xl)$/,
  fontWeight: /^font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/,
  lineHeight: /^leading-(?:none|tight|snug|normal|relaxed|loose|\d+)$/,
  letterSpacing: /^tracking-(?:tighter|tight|normal|wide|wider|widest)$/,
  textAlign: /^text-(?:left|center|right|justify)$/,
  textTransform: /^(?:uppercase|lowercase|capitalize|normal-case)$/,
  textDecoration: /^(?:underline|line-through|no-underline)$/,
}

/**
 * Remove recognised Tailwind utility classes for the given property keys.
 * Operates per whole class token — a token containing ':' (a variant prefix
 * such as `hover:`/`md:`/`dark:`/`focus:`) is always kept untouched.
 */
export function stripRecognizedTailwind(className: string, propsBeingSet: string[]): string {
  const rules = propsBeingSet.map((p) => RULES[p]).filter((r): r is RegExp => !!r)
  if (rules.length === 0 || !className.trim()) return className

  const tokens = className.split(/\s+/).filter(Boolean)
  const kept = tokens.filter((token) => {
    if (token.includes(':')) return true
    return !rules.some((r) => r.test(token))
  })
  return kept.join(' ')
}
