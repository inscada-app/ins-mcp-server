const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // Settings
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (settings) => ipcRenderer.invoke("save-settings", settings),
  firstRunStart: (settings) => ipcRenderer.invoke("first-run-start", settings),
  licenseActivateAndStart: (settings) => ipcRenderer.invoke("license-activate-and-start", settings),
  requestRelaunch: () => ipcRenderer.invoke("request-relaunch"),

  // License
  validateLicense: (key) => ipcRenderer.invoke("validate-license", key),
  getLicenseStatus: () => ipcRenderer.invoke("get-license-status"),
  removeLicense: () => ipcRenderer.invoke("remove-license"),
  licenseOpenSettings: () => ipcRenderer.send("license-open-settings"),

  // Window controls
  minimizeWindow: () => ipcRenderer.send("window-minimize"),
  maximizeWindow: () => ipcRenderer.send("window-maximize"),
  closeWindow: () => ipcRenderer.send("window-close"),
  isMaximized: () => ipcRenderer.invoke("window-is-maximized"),

  // About
  getAppInfo: () => ipcRenderer.invoke("get-app-info"),
  closeAbout: () => ipcRenderer.send("close-about"),

  // Menu actions
  openSettings: () => ipcRenderer.send("open-settings"),
  openAbout: () => ipcRenderer.send("open-about"),

  // Test connections
  testInscadaApi: (config) => ipcRenderer.invoke("test-inscada-api", config),
  testClaude: (config) => ipcRenderer.invoke("test-claude", config),
  testOllama: (config) => ipcRenderer.invoke("test-ollama", config),
  testGemini: (config) => ipcRenderer.invoke("test-gemini", config),
});
