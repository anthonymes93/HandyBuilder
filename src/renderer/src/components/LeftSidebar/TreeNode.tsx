import { useState, useEffect } from 'react'
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  File,
  FileCode,
  FileText,
  Image,
  Braces
} from 'lucide-react'
import { FileNode } from '../../types'

interface TreeNodeProps {
  node: FileNode
  depth: number
  isSearching: boolean
}

function FileIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''

  const codeExts = new Set([
    'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs',
    'vue', 'svelte', 'astro',
    'html', 'htm',
    'css', 'scss', 'sass', 'less', 'styl',
    'py', 'rb', 'go', 'rs', 'php', 'c', 'cpp', 'h', 'java', 'kt', 'swift'
  ])
  const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif'])
  const textExts = new Set(['md', 'mdx', 'txt', 'rst'])
  const dataExts = new Set(['json', 'yaml', 'yml', 'toml', 'xml', 'csv', 'env', 'lock'])

  if (codeExts.has(ext)) return <FileCode className="w-3.5 h-3.5 text-blue-400 shrink-0" />
  if (imageExts.has(ext)) return <Image className="w-3.5 h-3.5 text-purple-400 shrink-0" />
  if (textExts.has(ext)) return <FileText className="w-3.5 h-3.5 text-gray-400 shrink-0" />
  if (dataExts.has(ext)) return <Braces className="w-3.5 h-3.5 text-yellow-400 shrink-0" />
  return <File className="w-3.5 h-3.5 text-gray-600 shrink-0" />
}

export function TreeNode({ node, depth, isSearching }: TreeNodeProps) {
  const [isExpanded, setIsExpanded] = useState(depth === 0)

  useEffect(() => {
    if (isSearching) setIsExpanded(true)
  }, [isSearching])

  const paddingLeft = 8 + depth * 14

  if (node.type === 'directory') {
    return (
      <div>
        <button
          onClick={() => setIsExpanded((prev) => !prev)}
          className="w-full flex items-center gap-1 py-0.5 pr-2 hover:bg-gray-800 text-left transition-colors"
          style={{ paddingLeft }}
        >
          <span className="text-gray-700 shrink-0 w-3.5">
            {isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
          </span>
          {isExpanded ? (
            <FolderOpen className="w-3.5 h-3.5 text-yellow-400/90 shrink-0" />
          ) : (
            <Folder className="w-3.5 h-3.5 text-yellow-400/90 shrink-0" />
          )}
          <span className="text-gray-300 text-xs truncate ml-1">{node.name}</span>
        </button>

        {isExpanded && node.children && node.children.length > 0 && (
          <div>
            {node.children.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                isSearching={isSearching}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className="flex items-center gap-1 py-0.5 pr-2 hover:bg-gray-800 cursor-default transition-colors"
      style={{ paddingLeft: paddingLeft + 18 }}
      title={node.name}
    >
      <FileIcon name={node.name} />
      <span className="text-gray-400 text-xs truncate ml-1">{node.name}</span>
    </div>
  )
}
