const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // Settings
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (settings) => ipcRenderer.invoke("save-settings", settings),
  firstRunStart: (settings) => ipcRenderer.invoke("first-run-start", settings),
  requestRelaunch: () => ipcRenderer.invoke("request-relaunch"),

  // Window controls
  minimizeWindow: () => ipcRenderer.send("window-minimize"),
  maximizeWindow: () => ipcRenderer.send("window-maximize"),
  closeWindow: () => ipcRenderer.send("window-close"),
  isMaximized: () => ipcRenderer.invoke("window-is-maximized"),

  // About
  getAppInfo: () => ipcRenderer.invoke("get-app-info"),
  closeAbout: () => ipcRenderer.send("close-about"),

  // Test connections
  testPostgres: (config) => ipcRenderer.invoke("test-postgres", config),
  testInflux: (config) => ipcRenderer.invoke("test-influx", config),
  testInscadaApi: (config) => ipcRenderer.invoke("test-inscada-api", config),
});
