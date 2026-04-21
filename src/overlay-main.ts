import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { app, BrowserWindow, ipcMain, screen, session, type Session } from 'electron';

interface OverlayArgs {
  helperUrl: string;
  mpvPid: number | null;
  yomitanExtensionPath: string;
}

interface WindowBounds {
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

const args = parseArgs(process.argv.slice(2));
const userDataPath = resolveUserDataPath(args.mpvPid);
const persistentSessionPath = resolvePersistentSessionPath();
const logPath = path.join(userDataPath, 'overlay.log');
const hasYomitanExtensionPath = Boolean(args.yomitanExtensionPath.trim());
let overlayWindow: BrowserWindow | null = null;
let yomitanSettingsWindow: BrowserWindow | null = null;
let yomitanExtensionId: string | null = null;
let yomitanExtensionLoadPromise: Promise<void> | null = null;
let overlaySession: Session | null = null;
let boundsWatcher: ChildProcessWithoutNullStreams | null = null;
let lastBoundsKey = '';
let lastVisibilityKey = '';
let receivedBounds = false;
let logBuffer: string[] = [];
let logFlushScheduled = false;

fs.promises.mkdir(userDataPath, { recursive: true }).catch(() => {});
appendLog('boot: created user data directory');
if (hasYomitanExtensionPath) {
  fs.promises.mkdir(persistentSessionPath, { recursive: true }).catch(() => {});
  appendLog(`boot: using persistent session path ${persistentSessionPath}`);
}
app.setPath('userData', userDataPath);
appendLog('boot: set userData path');
app.commandLine.appendSwitch('disk-cache-dir', path.join(userDataPath, 'DiskCache'));
appendLog('boot: set disk cache dir');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
appendLog('boot: disabled gpu shader disk cache');
app.setName('SentenceMiner Overlay');
appendLog('boot: set app name');

app.whenReady().then(async () => {
  appendLog(`starting overlay helperUrl=${args.helperUrl} mpvPid=${args.mpvPid ?? 'none'} userData=${userDataPath}`);
  const persistentSession = getOverlaySession();
  overlayWindow = createOverlayWindow(persistentSession, args.helperUrl);
  overlayWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
    appendLog(`page load failed ${errorCode} ${errorDescription} ${validatedUrl}`);
  });
  overlayWindow.webContents.on('did-finish-load', () => {
    appendLog('overlay page loaded');
  });
  overlayWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    appendLog(`overlay console[${level}] ${sourceId}:${line} ${message}`);
  });
  void loadOverlayPageWithRetry(overlayWindow, `${trimTrailingSlash(args.helperUrl)}/overlay.html`);
  startBoundsWatcher(args.mpvPid, overlayWindow);
  setTimeout(showFallbackWindowIfNeeded, 2000);

  if (hasYomitanExtensionPath) {
    setupExtensionDiagnostics(persistentSession);
    yomitanExtensionLoadPromise = loadYomitanExtension(persistentSession, args.yomitanExtensionPath);
  } else {
    appendLog('boot: no Yomitan extension path configured; skipping extension session startup');
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  boundsWatcher?.kill();
});

ipcMain.on('overlay:set-interactive', (_event, interactive: boolean) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  overlayWindow.setIgnoreMouseEvents(!interactive, {
    forward: true,
  });
});

ipcMain.on('overlay:open-yomitan-settings', () => {
  void openYomitanSettingsWindow();
});

function createOverlayWindow(persistentSession: Session, helperUrl: string): BrowserWindow {
  const preload = path.join(__dirname, 'overlay-preload.cjs');
  const window = new BrowserWindow({
    width: 1280,
    height: 720,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: true,
    focusable: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      session: persistentSession,
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      devTools: true,
    },
  });

  window.setMenuBarVisibility(false);
  window.setIgnoreMouseEvents(true, {
    forward: true,
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(trimTrailingSlash(helperUrl))) {
      return { action: 'allow' };
    }

    return { action: 'deny' };
  });

  return window;
}

async function loadOverlayPageWithRetry(window: BrowserWindow, url: string): Promise<void> {
  let attempt = 0;
  while (!window.isDestroyed()) {
    try {
      await window.loadURL(url);
      appendLog(`overlay page load requested ${url}`);
      return;
    } catch (error) {
      attempt += 1;
      const delayMs = Math.min(5000, 500 * attempt);
      appendLog(
        `loadURL failed attempt=${attempt} retryInMs=${delayMs}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await delay(delayMs);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadYomitanExtension(persistentSession: Session, extensionPath: string): Promise<void> {
  const normalizedPath = extensionPath.trim();
  if (!normalizedPath) {
    return;
  }

  if (!fs.existsSync(normalizedPath)) {
    console.warn(`SentenceMiner overlay: Yomitan extension path does not exist: ${normalizedPath}`);
    return;
  }

  try {
    const readyPromise = waitForExtensionReady(persistentSession);
    const extensions = (persistentSession as any).extensions;
    if (extensions?.loadExtension) {
      const extension = await extensions.loadExtension(normalizedPath, {
        allowFileAccess: true,
      });
      yomitanExtensionId = extension?.id ?? null;
      await readyPromise;
      await startYomitanServiceWorker(persistentSession);
      appendLog(`loaded Yomitan extension id=${yomitanExtensionId ?? 'unknown'} path=${normalizedPath}`);
      return;
    }

    const extension = await persistentSession.loadExtension(normalizedPath, {
      allowFileAccess: true,
    });
    yomitanExtensionId = extension?.id ?? null;
    await readyPromise;
    await startYomitanServiceWorker(persistentSession);
    appendLog(`loaded Yomitan extension id=${yomitanExtensionId ?? 'unknown'} path=${normalizedPath}`);
  } catch (error) {
    appendLog(`could not load Yomitan extension: ${error instanceof Error ? error.message : String(error)}`);
    console.warn(`SentenceMiner overlay: could not load Yomitan extension: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function setupExtensionDiagnostics(persistentSession: Session): void {
  persistentSession.on('extension-loaded', (_event, extension) => {
    appendLog(`extension loaded event id=${extension.id} name=${extension.name}`);
  });
  persistentSession.on('extension-ready', (_event, extension) => {
    appendLog(`extension ready event id=${extension.id} name=${extension.name}`);
  });

  const serviceWorkers = persistentSession.serviceWorkers;
  serviceWorkers.on('registration-completed', (_event, details) => {
    appendLog(`service worker registered scope=${details.scope}`);
  });
  serviceWorkers.on('running-status-changed', (details: any) => {
    appendLog(`service worker status version=${details.versionId} status=${details.runningStatus}`);
  });
  serviceWorkers.on('console-message', (_event, details) => {
    appendLog(
      `service worker console[${details.level}] ${details.sourceUrl}:${details.lineNumber} ${details.message}`,
    );
  });
}

function waitForExtensionReady(persistentSession: Session): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      appendLog('timed out waiting for extension ready event; continuing');
      persistentSession.off('extension-ready', onReady);
      resolve();
    }, 5000);

    const onReady = () => {
      clearTimeout(timeout);
      persistentSession.off('extension-ready', onReady);
      resolve();
    };

    persistentSession.on('extension-ready', onReady);
  });
}

async function startYomitanServiceWorker(persistentSession: Session): Promise<void> {
  if (!yomitanExtensionId) {
    return;
  }

  const scope = `chrome-extension://${yomitanExtensionId}/`;
  try {
    await persistentSession.serviceWorkers.startWorkerForScope(scope);
    appendLog(`started Yomitan service worker scope=${scope}`);
  } catch (error) {
    appendLog(`could not start Yomitan service worker: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function openYomitanSettingsWindow(): Promise<void> {
  if (yomitanExtensionLoadPromise) {
    await yomitanExtensionLoadPromise;
  }

  if (!yomitanExtensionId) {
    appendLog('cannot open Yomitan settings because the extension is not loaded');
    return;
  }

  const url = `chrome-extension://${yomitanExtensionId}/settings.html`;
  if (yomitanSettingsWindow && !yomitanSettingsWindow.isDestroyed()) {
    appendLog(`reloading Yomitan settings ${url}`);
    yomitanSettingsWindow.show();
    yomitanSettingsWindow.focus();
    yomitanSettingsWindow.loadURL(url).catch((error) => {
      appendLog(`failed to reload Yomitan settings: ${error instanceof Error ? error.message : String(error)}`);
    });
    return;
  }

  yomitanSettingsWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    title: 'Yomitan Settings',
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      session: getOverlaySession(),
      devTools: true,
    },
  });
  yomitanSettingsWindow.setMenuBarVisibility(false);
  yomitanSettingsWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    appendLog(`Yomitan settings console[${level}] ${sourceId}:${line} ${message}`);
  });
  yomitanSettingsWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
    appendLog(`Yomitan settings load failed ${errorCode} ${errorDescription} ${validatedUrl}`);
  });
  yomitanSettingsWindow.webContents.on('did-finish-load', () => {
    appendLog(`Yomitan settings page loaded ${url}`);
    setTimeout(logYomitanSettingsState, 1000);
    setTimeout(logYomitanSettingsState, 3000);
  });
  yomitanSettingsWindow.webContents.on('render-process-gone', (_event, details) => {
    appendLog(`Yomitan settings renderer gone reason=${details.reason} exitCode=${details.exitCode}`);
  });
  appendLog(`opening Yomitan settings ${url}`);
  yomitanSettingsWindow.once('ready-to-show', () => {
    yomitanSettingsWindow?.show();
    yomitanSettingsWindow?.focus();
  });
  yomitanSettingsWindow.on('closed', () => {
    yomitanSettingsWindow = null;
  });
  yomitanSettingsWindow.loadURL(url).catch((error) => {
    appendLog(`failed to open Yomitan settings: ${error instanceof Error ? error.message : String(error)}`);
  });
}

function logYomitanSettingsState(): void {
  if (!yomitanSettingsWindow || yomitanSettingsWindow.isDestroyed()) {
    return;
  }

  yomitanSettingsWindow.webContents.executeJavaScript(
    `({
      bodyHidden: document.body.hidden,
      loaded: document.documentElement.dataset.loaded || '',
      loadingStalled: document.documentElement.dataset.loadingStalled || '',
      textLength: document.body.innerText.length,
      hasChromeRuntime: typeof chrome === 'object' && !!chrome.runtime
    })`,
  ).then((state) => {
    appendLog(`Yomitan settings state ${JSON.stringify(state)}`);
  }).catch((error) => {
    appendLog(`failed to inspect Yomitan settings state: ${error instanceof Error ? error.message : String(error)}`);
  });
}

function getOverlaySession(): Session {
  if (!overlaySession) {
    if (!hasYomitanExtensionPath) {
      overlaySession = session.defaultSession;
      return overlaySession;
    }

    migrateLegacySessionStorage();
    overlaySession = session.fromPath(persistentSessionPath, {
      cache: false,
    });
  }

  return overlaySession;
}

function resolveUserDataPath(mpvPid: number | null): string {
  const base = resolveLocalDataBase();
  const profileName = mpvPid && Number.isInteger(mpvPid) && mpvPid > 0
    ? `mpv-${mpvPid}`
    : 'manual';

  return path.join(base, 'SentenceMinerOverlay', profileName);
}

function resolvePersistentSessionPath(): string {
  return path.join(resolveLocalDataBase(), 'SentenceMinerOverlay', 'profile');
}

function resolveLocalDataBase(): string {
  return (
    process.env.LOCALAPPDATA ||
    process.env.APPDATA ||
    path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Local')
  );
}

function migrateLegacySessionStorage(): void {
  if (hasSessionStorage(persistentSessionPath)) {
    return;
  }

  const legacySessionPath = findLatestLegacySessionPath();
  if (!legacySessionPath) {
    return;
  }

  for (const entry of [
    'Local Extension Settings',
    'IndexedDB',
    'Local Storage',
    'Session Storage',
    'databases',
    'Preferences',
  ]) {
    const sourcePath = path.join(legacySessionPath, entry);
    if (!fs.existsSync(sourcePath)) {
      continue;
    }

    try {
      fs.cpSync(sourcePath, path.join(persistentSessionPath, entry), {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
    } catch (error) {
      appendLog(`could not migrate legacy session entry ${entry}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  appendLog(`migrated Yomitan session storage from ${legacySessionPath}`);
}

function findLatestLegacySessionPath(): string | null {
  const base = path.join(resolveLocalDataBase(), 'SentenceMinerOverlay');
  if (!fs.existsSync(base)) {
    return null;
  }

  const currentPath = path.resolve(userDataPath);
  const persistentPath = path.resolve(persistentSessionPath);
  const candidates = fs.readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(base, entry.name))
    .filter((candidatePath) => {
      const resolved = path.resolve(candidatePath);
      return resolved !== currentPath && resolved !== persistentPath && hasSessionStorage(candidatePath);
    })
    .map((candidatePath) => ({
      path: candidatePath,
      mtime: fs.statSync(candidatePath).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return candidates[0]?.path ?? null;
}

function hasSessionStorage(profilePath: string): boolean {
  return [
    'Local Extension Settings',
    'IndexedDB',
    'Local Storage',
    'Preferences',
  ].some((entry) => fs.existsSync(path.join(profilePath, entry)));
}

function startBoundsWatcher(mpvPid: number | null, window: BrowserWindow): void {
  if (process.platform !== 'win32') {
    appendLog('non-Windows platform; showing fallback overlay window');
    window.showInactive();
    return;
  }

  if (!mpvPid || !Number.isInteger(mpvPid) || mpvPid <= 0) {
    appendLog('missing mpv pid; showing fallback overlay window');
    window.showInactive();
    return;
  }

  const overlayHwnd = getNativeWindowHandleValue(window);
  if (!overlayHwnd) {
    appendLog('could not read overlay window handle; keeping overlay hidden');
    return;
  }

  const script = buildWindowBoundsScript(mpvPid, overlayHwnd);
  appendLog(`starting window bounds watcher for mpv pid ${mpvPid} overlay hwnd ${overlayHwnd}`);
  boundsWatcher = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  boundsWatcher.stdout.setEncoding('utf8');
  boundsWatcher.stderr.setEncoding('utf8');

  let buffered = '';
  boundsWatcher.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    let newlineIndex = buffered.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffered.slice(0, newlineIndex).trim();
      buffered = buffered.slice(newlineIndex + 1);
      if (line) {
        applyBoundsLine(line);
      }
      newlineIndex = buffered.indexOf('\n');
    }
  });
  boundsWatcher.stderr.on('data', (chunk: string) => {
    const message = chunk.trim();
    if (message) {
      appendLog(`bounds watcher stderr: ${message}`);
      console.warn(`SentenceMiner overlay bounds watcher: ${message}`);
    }
  });
  boundsWatcher.on('error', (error) => {
    appendLog(`bounds watcher failed: ${error.message}`);
  });
  boundsWatcher.on('exit', (code, signal) => {
    appendLog(`bounds watcher exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    app.quit();
  });
}

function applyBoundsLine(line: string): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  let bounds: WindowBounds;
  try {
    bounds = JSON.parse(line) as WindowBounds;
  } catch {
    return;
  }

  receivedBounds = true;
  const visibilityKey = bounds.visible ? 'visible' : 'hidden';
  if (visibilityKey !== lastVisibilityKey) {
    lastVisibilityKey = visibilityKey;
    appendLog(`mpv window visibility ${visibilityKey}`);
  }

  if (!bounds.visible || bounds.width <= 0 || bounds.height <= 0) {
    overlayWindow.hide();
    return;
  }

  const nextKey = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
  if (nextKey !== lastBoundsKey) {
    lastBoundsKey = nextKey;
    appendLog(`applying bounds ${nextKey}`);
    overlayWindow.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
  }

  if (!overlayWindow.isVisible()) {
    overlayWindow.showInactive();
  }
}

function showFallbackWindowIfNeeded(): void {
  if (!overlayWindow || overlayWindow.isDestroyed() || receivedBounds) {
    return;
  }

  if (args.mpvPid && Number.isInteger(args.mpvPid) && args.mpvPid > 0) {
    appendLog(`no mpv bounds received for pid ${args.mpvPid}; keeping overlay hidden`);
    return;
  }

  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  const fallbackBounds = {
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
  };
  appendLog(`no mpv bounds received; showing fallback bounds ${JSON.stringify(fallbackBounds)}`);
  overlayWindow.setBounds(fallbackBounds);
  overlayWindow.showInactive();
}

function getNativeWindowHandleValue(window: BrowserWindow): string | null {
  const handle = window.getNativeWindowHandle();
  if (handle.length >= 8) {
    const value = handle.readBigUInt64LE(0);
    return value > 0n ? value.toString() : null;
  }

  if (handle.length >= 4) {
    const value = handle.readUInt32LE(0);
    return value > 0 ? String(value) : null;
  }

  return null;
}

function buildWindowBoundsScript(pid: number, overlayHwnd: string): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32WindowBounds {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW", SetLastError=true)] private static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
  [DllImport("user32.dll", EntryPoint="SetWindowLongW", SetLastError=true)] private static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);
  public static IntPtr SetWindowOwner(IntPtr hWnd, IntPtr owner) {
    const int GWLP_HWNDPARENT = -8;
    if (IntPtr.Size == 8) {
      return SetWindowLongPtr64(hWnd, GWLP_HWNDPARENT, owner);
    }
    return new IntPtr(SetWindowLong32(hWnd, GWLP_HWNDPARENT, owner.ToInt32()));
  }
}
"@
$targetPid = ${pid}
$overlayHwnd = [IntPtr]::new([Int64]"${overlayHwnd}")
$lastOwnerHwnd = [IntPtr]::Zero
while ($true) {
  if (-not (Get-Process -Id $targetPid)) { break }
  $script:found = [IntPtr]::Zero
  [Win32WindowBounds]::EnumWindows({
    param($hWnd, $lParam)
    $windowPid = 0
    [Win32WindowBounds]::GetWindowThreadProcessId($hWnd, [ref]$windowPid) | Out-Null
    if ($windowPid -eq $targetPid -and [Win32WindowBounds]::IsWindowVisible($hWnd)) {
      $script:found = $hWnd
      return $false
    }
    return $true
  }, [IntPtr]::Zero) | Out-Null

  if ($script:found -eq [IntPtr]::Zero -or [Win32WindowBounds]::IsIconic($script:found)) {
    '{"visible":false,"x":0,"y":0,"width":0,"height":0}'
  } else {
    if ($lastOwnerHwnd -ne $script:found) {
      [Win32WindowBounds]::SetWindowOwner($overlayHwnd, $script:found) | Out-Null
      $lastOwnerHwnd = $script:found
    }
    $rect = New-Object Win32WindowBounds+RECT
    $point = New-Object Win32WindowBounds+POINT
    [Win32WindowBounds]::GetClientRect($script:found, [ref]$rect) | Out-Null
    [Win32WindowBounds]::ClientToScreen($script:found, [ref]$point) | Out-Null
    $width = [Math]::Max(0, $rect.Right - $rect.Left)
    $height = [Math]::Max(0, $rect.Bottom - $rect.Top)
    $payload = @{
      visible = $true
      x = $point.X
      y = $point.Y
      width = $width
      height = $height
    }
    $payload | ConvertTo-Json -Compress
  }
  Start-Sleep -Milliseconds 150
}
`;
}

function parseArgs(argv: string[]): OverlayArgs {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  return {
    helperUrl: readStringArg(argv, '--helper-url') || positional[0] || 'http://127.0.0.1:8766',
    mpvPid: readIntegerArg(argv, '--mpv-pid') ?? parseInteger(positional[1]),
    yomitanExtensionPath: readStringArg(argv, '--yomitan-extension-path') || positional[2] || '',
  };
}

function readStringArg(argv: string[], key: string): string | null {
  const index = argv.indexOf(key);
  if (index === -1) {
    return null;
  }

  return argv[index + 1] ?? null;
}

function readIntegerArg(argv: string[], key: string): number | null {
  const value = readStringArg(argv, key);
  if (!value) {
    return null;
  }

  return parseInteger(value);
}

function parseInteger(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function appendLog(message: string): void {
  logBuffer.push(`[${new Date().toISOString()}] ${message}\n`);
  if (logFlushScheduled) {
    return;
  }

  logFlushScheduled = true;
  setImmediate(() => {
    logFlushScheduled = false;
    const content = logBuffer.join('');
    logBuffer = [];
    fs.promises.mkdir(path.dirname(logPath), { recursive: true })
      .then(() => fs.promises.appendFile(logPath, content, 'utf8'))
      .catch(() => {
        // Logging must never prevent the overlay from starting.
      });
  });
}
