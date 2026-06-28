import { BrowserWindow } from 'electron'

/** Return and focus the active HandyBuilder window for native modal dialogs. */
export function getDialogParent(mainWindow: BrowserWindow): BrowserWindow {
  const focusedWindow = BrowserWindow.getFocusedWindow()
  const parentWindow = focusedWindow && !focusedWindow.isDestroyed()
    ? focusedWindow
    : mainWindow

  if (!parentWindow.isDestroyed()) parentWindow.focus()
  return parentWindow
}
