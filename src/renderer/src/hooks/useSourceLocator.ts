import { useState, useEffect, useCallback, useRef } from 'react'
import { TextEditPayload, SourceMatch, TextEditAnalysis } from '../types'

export interface UseSourceLocatorReturn {
  query: string
  setQuery: (q: string) => void
  results: SourceMatch[]
  analysis: TextEditAnalysis | null
  isSearching: boolean
  searchError: string | null
}

const DEBOUNCE_MS = 350

export function useSourceLocator(
  projectPath: string | null,
  payload: TextEditPayload | null
): UseSourceLocatorReturn {
  const [query,       setQuery]       = useState('')
  const [results,     setResults]     = useState<SourceMatch[]>([])
  const [analysis,    setAnalysis]    = useState<TextEditAnalysis | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Seed query from payload when panel opens
  useEffect(() => {
    if (payload) {
      setQuery(payload.oldText.trim())
      setResults([])
      setAnalysis(null)
      setSearchError(null)
    }
  }, [payload])

  // Debounced project search
  useEffect(() => {
    if (!projectPath || !payload || !query.trim()) {
      setResults([])
      setAnalysis(null)
      setSearchError(null)
      return
    }

    if (timerRef.current) clearTimeout(timerRef.current)

    timerRef.current = setTimeout(async () => {
      setIsSearching(true)
      setSearchError(null)
      try {
        const result = await window.api.searchProject({
          projectPath,
          query:   query.trim(),
          newText: payload.newText,
        })
        setAnalysis(result)
        setResults(result.matches)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[useSourceLocator] searchProject failed:', msg)
        setSearchError(msg)
        setResults([])
        setAnalysis(null)
      } finally {
        setIsSearching(false)
      }
    }, DEBOUNCE_MS)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [projectPath, query, payload])

  const stableSetQuery = useCallback((q: string) => setQuery(q), [])

  return { query, setQuery: stableSetQuery, results, analysis, isSearching, searchError }
}
