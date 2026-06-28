import { dialog, BrowserWindow } from 'electron'
import * as path from 'path'
import { readDirectory, FileNode } from '../filesystem'
import { getDialogParent } from '../dialogParent'

export interface Project {
  path: string
  name: string
}

export class ProjectManager {
  private currentProject: Project | null = null

  async openProjectDialog(parentWindow: BrowserWindow): Promise<Project | null> {
    const dialogParent = getDialogParent(parentWindow)
    const result = await dialog.showOpenDialog(dialogParent, {
      properties: ['openDirectory'],
      title: 'Open Project Folder'
    })

    if (result.canceled || !result.filePaths[0]) return null

    const projectPath = result.filePaths[0]
    this.currentProject = {
      path: projectPath,
      name: path.basename(projectPath)
    }

    return this.currentProject
  }

  getProject(): Project | null {
    return this.currentProject
  }

  getFileTree(): FileNode[] {
    if (!this.currentProject) return []
    return readDirectory(this.currentProject.path)
  }
}
