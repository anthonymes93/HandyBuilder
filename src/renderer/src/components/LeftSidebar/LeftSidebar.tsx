import { useState } from 'react'
import { FolderOpen, Search, X } from 'lucide-react'
import { Project, FileNode } from '../../types'
import { FileTree } from './FileTree'

interface LeftSidebarProps {
  project: Project | null
  fileTree: FileNode[]
  isLoading: boolean
  onOpenProject: () => void
}

export function LeftSidebar({ project, fileTree, isLoading, onOpenProject }: LeftSidebarProps) {
  const [searchQuery, setSearchQuery] = useState('')

  return (
    <div className="w-60 flex flex-col bg-gray-900 border-r border-gray-800 shrink-0">
      <div className="p-2.5 border-b border-gray-800">
        <button
          onClick={onOpenProject}
          disabled={isLoading}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white text-sm rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <FolderOpen className="w-4 h-4" />
          {isLoading ? 'Opening…' : 'Open Project'}
        </button>
      </div>

      {project && (
        <div className="px-2 py-1.5 border-b border-gray-800">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-600 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search files…"
              className="w-full bg-gray-800 text-gray-300 text-xs placeholder-gray-600 pl-8 pr-7 py-1.5 rounded border border-gray-700 focus:border-blue-500 focus:outline-none transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {!project ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 p-6">
            <FolderOpen className="w-10 h-10 text-gray-800" />
            <p className="text-gray-700 text-xs text-center leading-relaxed">
              Open a project folder to browse files
            </p>
          </div>
        ) : (
          <FileTree nodes={fileTree} searchQuery={searchQuery} />
        )}
      </div>
    </div>
  )
}
