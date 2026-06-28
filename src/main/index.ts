import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { ProjectManager } from './project/manager'
import { DevServerManager } from './devserver/manager'
import { setupIpcHandlers } from './ipc/handlers'

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'HandyBuilder',
    backgroundColor: '#030712',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webviewTag: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.handybuilder.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  const projectManager = new ProjectManager()
  const devServerManager = new DevServerManager()

  const mainWindow = createWindow()
  setupIpcHandlers(mainWindow, projectManager, devServerManager)

  // Stop the dev server when the window closes so its child process cannot
  // emit events to an already-destroyed webContents. The 'closed' handler in
  // setupIpcHandlers clears callbacks first; this ensures the process is also killed.
  mainWindow.on('close', () => {
    devServerManager.stop().catch(() => {})
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('before-quit', () => {
    devServerManager.stop().catch(() => {})
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
