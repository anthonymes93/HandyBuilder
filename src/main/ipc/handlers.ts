import { ipcMain, shell, dialog, BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { join, relative, sep, extname, basename } from 'path'
import * as fs from 'fs'
import { getDialogParent } from '../dialogParent'
import { ProjectManager } from '../project/manager'
import { DevServerManager } from '../devserver/manager'
import {
  analyzeTextEdit,
  analyzeLocatedEdit,
  commitTextEdit,
  AnalyzeParams,
  LocatedEditParams,
  CommitParams
} from '../editor/fileEditor'
import { writeInlineStyle, WriteInlineStyleParams, writeArrayItemProp, WriteArrayItemPropParams, updateArrayItemText, UpdateArrayItemTextParams } from '../editor/styleWriter'
import { astLocateBinding, AstLocateParams } from '../editor/astEditor'
import { writeImageAttrs, WriteImageAttrsParams } from '../editor/imageWriter'
import { writeElementStyle, WriteElementStyleParams } from '../editor/elementStyleWriter'
import {
  getHistoryState,
  recordHistoryEntry,
  undoHistory,
  redoHistory,
  clearHistory,
  discardHistoryForFile,
  RecordEntryParams
} from '../editor/historyManager'
import {
  getMapping,
  saveMapping,
  ElementMapping
} from '../editor/mappingStore'

// Guard every renderer send: do nothing if the window or its webContents is already destroyed.
function safeSend(window: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (window.isDestroyed()) return
  if (window.webContents.isDestroyed()) return
  window.webContents.send(channel, ...args)
}

export function setupIpcHandlers(
  mainWindow: BrowserWindow,
  projectManager: ProjectManager,
  devServerManager: DevServerManager
): void {
  devServerManager.setCallbacks({
    onUrlDetected: (url) => safeSend(mainWindow, 'devserver:url', url),
    onLog: (log) => safeSend(mainWindow, 'devserver:log', log),
    onStatusChange: (status) => safeSend(mainWindow, 'devserver:status', status)
  })

  // When the window is destroyed, immediately clear all callbacks so the still-running
  // child process can no longer reach the (now destroyed) webContents.
  mainWindow.on('closed', () => {
    devServerManager.setCallbacks({})
    devServerManager.stop().catch(() => {})
  })

  ipcMain.handle('project:open', async () => {
    const project = await projectManager.openProjectDialog(mainWindow)
    if (!project) return null

    devServerManager.start(project.path).catch((err: Error) => {
      safeSend(mainWindow, 'devserver:log', `[handybuilder] Error: ${err.message}\n`)
      safeSend(mainWindow, 'devserver:status', 'error')
    })

    return { project, fileTree: projectManager.getFileTree() }
  })

  ipcMain.handle('project:get', () => projectManager.getProject())

  ipcMain.handle('project:file-tree', () => projectManager.getFileTree())

  ipcMain.handle('preview:reload', async () => {
    const project = projectManager.getProject()
    if (!project) return
    await devServerManager.stop()
    await devServerManager.start(project.path)
  })

  ipcMain.handle('preview:open-in-browser', async () => {
    const url = devServerManager.getUrl()
    if (url) await shell.openExternal(url)
  })

  ipcMain.handle('devserver:get-url', () => devServerManager.getUrl())

  ipcMain.handle('inspector:get-bridge-path', () =>
    `file://${join(__dirname, '../preload/inspectorBridge.js')}`
  )

  // Scan project for all occurrences of oldText — does NOT write anything.
  ipcMain.handle('editor:analyze-text', (_e: IpcMainInvokeEvent, params: AnalyzeParams) =>
    analyzeTextEdit(params)
  )

  // Search a single file near a known line — used when source metadata is available.
  ipcMain.handle('editor:analyze-located', (_e: IpcMainInvokeEvent, params: LocatedEditParams) =>
    analyzeLocatedEdit(params)
  )

  // Write newText in place of oldText in a specific file chosen by the user.
  ipcMain.handle('editor:commit-text-edit', (_e: IpcMainInvokeEvent, params: CommitParams) =>
    commitTextEdit(params)
  )

  // Write or merge a JSX inline style={{ ... }} prop using source metadata.
  ipcMain.handle('editor:write-inline-style', (_e: IpcMainInvokeEvent, params: WriteInlineStyleParams) =>
    writeInlineStyle(params)
  )

  // Update a single property on a specific array item identified by a unique string value.
  ipcMain.handle('editor:write-array-item-prop', (_e: IpcMainInvokeEvent, params: WriteArrayItemPropParams) =>
    writeArrayItemProp(params)
  )

  // Update a text field value inside a specific array item (identified by a unique itemId string).
  ipcMain.handle('editor:update-array-item-text', (_e: IpcMainInvokeEvent, params: UpdateArrayItemTextParams) =>
    updateArrayItemText(params)
  )

  // Parse the source file AST and return all binding locations for a displayed text.
  ipcMain.handle('editor:ast-locate-binding', (_e: IpcMainInvokeEvent, params: AstLocateParams) =>
    astLocateBinding(params)
  )

  // Update <img> src/alt/width/height attributes directly via AST — never via text search.
  ipcMain.handle('editor:write-image-attrs', (_e: IpcMainInvokeEvent, params: WriteImageAttrsParams) =>
    writeImageAttrs(params)
  )

  // Visual Button/Text style editor Save — normal styles inline, hover styles
  // via a stable class + shared stylesheet. One atomic multi-file transaction.
  ipcMain.handle('editor:write-element-style', (_e: IpcMainInvokeEvent, params: WriteElementStyleParams) =>
    writeElementStyle(params)
  )

  // ── Edit history (Undo/Redo) ────────────────────────────────────────────
  ipcMain.handle('history:get-state', (_e: IpcMainInvokeEvent, params: { projectPath: string }) =>
    getHistoryState(params.projectPath)
  )

  // Record a history entry directly (for editors that don't go through
  // applySourceTransaction). Every current writer already records automatically.
  ipcMain.handle('history:record', (
    _e: IpcMainInvokeEvent,
    params: { projectPath: string } & RecordEntryParams
  ) => recordHistoryEntry(params.projectPath, params))

  ipcMain.handle('history:undo', (_e: IpcMainInvokeEvent, params: { projectPath: string }) =>
    undoHistory(params.projectPath)
  )

  ipcMain.handle('history:redo', (_e: IpcMainInvokeEvent, params: { projectPath: string }) =>
    redoHistory(params.projectPath)
  )

  ipcMain.handle('history:clear', (_e: IpcMainInvokeEvent, params: { projectPath: string }) =>
    clearHistory(params.projectPath)
  )

  // Drop history entries referencing one file — used when Undo/Redo detects
  // the file was changed outside HandyBuilder and the user opts to discard.
  ipcMain.handle('history:discard-file', (
    _e: IpcMainInvokeEvent,
    params: { projectPath: string; filePath: string }
  ) => discardHistoryForFile(params.projectPath, params.filePath))

  // Open a file in the system default editor (e.g. VS Code).
  ipcMain.handle('editor:open-file', async (_e: IpcMainInvokeEvent, filePath: string) => {
    const err = await shell.openPath(filePath)
    return err ? { error: err } : { success: true }
  })

  // Reveal a file in the OS file manager.
  ipcMain.handle('editor:show-in-folder', (_e: IpcMainInvokeEvent, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  // Search the project with any user query — used by the Source Locator panel.
  ipcMain.handle('editor:search-project', (
    _e: IpcMainInvokeEvent,
    params: { projectPath: string; query: string; newText: string }
  ) => {
    if (!params.query.trim()) {
      return { oldText: '', newText: params.newText, matchCount: 0, matches: [], needsConfirmation: false }
    }
    return analyzeTextEdit({
      projectPath: params.projectPath,
      oldText:     params.query,
      newText:     params.newText,
    })
  })

  // Get the stored element→source mapping for a given element key.
  ipcMain.handle('editor:get-mapping', (
    _e: IpcMainInvokeEvent,
    params: { projectPath: string; key: string }
  ): ElementMapping | null => {
    return getMapping(params.projectPath, params.key)
  })

  // Save a manually-confirmed element→source mapping.
  ipcMain.handle('editor:save-mapping', (
    _e: IpcMainInvokeEvent,
    params: { projectPath: string; mapping: ElementMapping }
  ): void => {
    saveMapping(params.projectPath, params.mapping)
  })

  // Read a project file's content (text) — used by the Source Locator panel for manual line picking.
  ipcMain.handle('editor:read-file', (_e: IpcMainInvokeEvent, params: { filePath: string; projectPath: string }) => {
    const { filePath, projectPath } = params
    if (!filePath.startsWith(projectPath + sep)) {
      return { error: 'File is outside the project directory' }
    }
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      return { content }
    } catch (err) {
      return { error: String(err) }
    }
  })

  // Open a file-picker dialog for images anywhere on disk, copy into
  // public/handybuilder-assets/, and return the browser-usable URL.
  ipcMain.handle('image:pick-file', async () => {
    const project = projectManager.getProject()
    if (!project) return null

    const dialogParent = getDialogParent(mainWindow)
    const result = await dialog.showOpenDialog(dialogParent, {
      title: 'Choose Image',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }
      ]
    })

    if (result.canceled || !result.filePaths[0]) return null

    const sourcePath = result.filePaths[0]
    const ext        = extname(sourcePath).toLowerCase()
    const base       = basename(sourcePath, ext).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
    const destName   = `${base}-${Date.now()}${ext}`

    const assetsDir = join(project.path, 'public', 'handybuilder-assets')
    fs.mkdirSync(assetsDir, { recursive: true })
    fs.copyFileSync(sourcePath, join(assetsDir, destName))

    const relativePath = `public/handybuilder-assets/${destName}`
    const url          = `/handybuilder-assets/${destName}`
    return { url, relativePath }
  })
}
