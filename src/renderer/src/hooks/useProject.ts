import { useState, useCallback } from 'react'
import { Project, FileNode, ProjectOpenResult } from '../types'

export function useProject() {
  const [project, setProject] = useState<Project | null>(null)
  const [fileTree, setFileTree] = useState<FileNode[]>([])
  const [isLoading, setIsLoading] = useState(false)

  const openProject = useCallback(async () => {
    setIsLoading(true)
    try {
      const result: ProjectOpenResult | null = await window.api.openProject()
      if (result) {
        setProject(result.project)
        setFileTree(result.fileTree)
      }
    } finally {
      setIsLoading(false)
    }
  }, [])

  const refreshFileTree = useCallback(async () => {
    const tree = await window.api.getFileTree()
    setFileTree(tree)
  }, [])

  return { project, fileTree, isLoading, openProject, refreshFileTree }
}
