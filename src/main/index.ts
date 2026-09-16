import path from 'node:path'
import { app, BrowserWindow, shell, Menu } from 'electron'
import { Services } from './services'
import { registerIpc } from './ipc/register'

let mainWindow: BrowserWindow | null = null
let services: Services | null = null

const isDev = !app.isPackaged

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Jarvis',
    backgroundColor: '#0A0D14',
    // macOS: keep the traffic lights but drop the title bar, so the app reads
    // as a single dark surface.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      // The renderer gets no Node access and no direct filesystem reach. Every
      // privileged operation goes through the IPC surface in ipc/register.ts.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    }
  })

  window.once('ready-to-show', () => window.show())

  // External links open in the user's browser, never inside Jarvis.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env['ELECTRON_RENDERER_URL']
    if (devServer && url.startsWith(devServer)) return
    event.preventDefault()
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return window
}

function buildMenu(): void {
  // A minimal macOS menu: the standard app/edit/window items, nothing invented.
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

void app.whenReady().then(async () => {
  app.setName('Jarvis')
  services = await Services.create()
  buildMenu()
  registerIpc(services, () => mainWindow)
  mainWindow = createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  services?.indexAbort?.abort()
  void services?.logger.info('app.quit')
  void services?.logger.flush()
})

// A second instance would fight over the same index files.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}
