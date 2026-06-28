import { FileNode } from '../../types'
import { TreeNode } from './TreeNode'

interface FileTreeProps {
  nodes: FileNode[]
  searchQuery: string
}

function filterTree(nodes: FileNode[], query: string): FileNode[] {
  const q = query.toLowerCase()
  return nodes.reduce<FileNode[]>((acc, node) => {
    if (node.type === 'directory' && node.children) {
      const filteredChildren = filterTree(node.children, query)
      if (filteredChildren.length > 0 || node.name.toLowerCase().includes(q)) {
        acc.push({ ...node, children: filteredChildren })
      }
    } else if (node.name.toLowerCase().includes(q)) {
      acc.push(node)
    }
    return acc
  }, [])
}

export function FileTree({ nodes, searchQuery }: FileTreeProps) {
  const displayed = searchQuery.trim() ? filterTree(nodes, searchQuery) : nodes

  if (displayed.length === 0 && searchQuery.trim()) {
    return (
      <div className="p-4 text-center">
        <p className="text-gray-700 text-xs">No files match "{searchQuery}"</p>
      </div>
    )
  }

  return (
    <div className="py-1">
      {displayed.map((node) => (
        <TreeNode key={node.path} node={node} depth={0} isSearching={!!searchQuery.trim()} />
      ))}
    </div>
  )
}
