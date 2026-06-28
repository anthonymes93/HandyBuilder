import * as fs from 'fs'
import * as path from 'path'

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

const IGNORED = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  '.vite',
  'build',
  '.cache',
  'coverage',
  'out',
  'release',
  '.DS_Store',
  'Thumbs.db'
])

export function readDirectory(dirPath: string, depth = 0): FileNode[] {
  if (depth > 6) return []

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return []
  }

  const nodes: FileNode[] = []

  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue

    const fullPath = path.join(dirPath, entry.name)

    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: fullPath,
        type: 'directory',
        children: readDirectory(fullPath, depth + 1)
      })
    } else if (entry.isFile()) {
      nodes.push({
        name: entry.name,
        path: fullPath,
        type: 'file'
      })
    }
  }

  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}
