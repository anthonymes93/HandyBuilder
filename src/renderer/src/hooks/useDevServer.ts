import { useState, useEffect } from 'react'
import { DevServerStatus } from '../types'

export function useDevServer() {
  const [url, setUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<DevServerStatus>('idle')
  const [logs, setLogs] = useState<string[]>([])

  useEffect(() => {
    window.api.onDevServerUrl((newUrl) => setUrl(newUrl))

    window.api.onDevServerLog((log) => {
      setLogs((prev) => [...prev.slice(-200), log])
    })

    window.api.onDevServerStatus((newStatus) => {
      setStatus(newStatus as DevServerStatus)
      if (newStatus === 'stopped' || newStatus === 'error') setUrl(null)
    })

    return () => {
      window.api.removeAllListeners('devserver:url')
      window.api.removeAllListeners('devserver:log')
      window.api.removeAllListeners('devserver:status')
    }
  }, [])

  return { url, status, logs }
}
