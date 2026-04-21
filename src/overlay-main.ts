import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { app, BrowserWindow, ipcMain, session } from 'electron';

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
let overlayWindow: BrowserWindow | null = null;
let boundsWatcher: ChildProcessWithoutNullStreams | null = null;
let lastBoundsKey = '';

app.setName('SentenceMiner Overlay');

app.whenReady().then(async () => {
  await loadYomitanExtension(args.yomitanExtensionPath);
  overlayWindow = createOverlayWindow(args.helperUrl);
  overlayWindow.loadURL(`${trimTrailingSlash(args.helperUrl)}/overlay.html`);
  startBoundsWatcher(args.mpvPid);
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

function createOverlayWindow(helperUrl: string): BrowserWindow {
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
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      devTools: true,
    },
  });

  window.setAlwaysOnTop(true, 'screen-saver');
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
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

async function loadYomitanExtension(extensionPath: string): Promise<void> {
  const normalizedPath = extensionPath.trim();
  if (!normalizedPath) {
    return;
  }

  if (!fs.existsSync(normalizedPath)) {
    console.warn(`SentenceMiner overlay: Yomitan extension path does not exist: ${normalizedPath}`);
    return;
  }

  try {
    const extensions = (session.defaultSession as any).extensions;
    if (extensions?.loadExtension) {
      await extensions.loadExtension(normalizedPath, {
        allowFileAccess: true,
      });
      return;
    }

    await session.defaultSession.loadExtension(normalizedPath, {
      allowFileAccess: true,
    });
  } catch (error) {
    console.warn(`SentenceMiner overlay: could not load Yomitan extension: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function startBoundsWatcher(mpvPid: number | null): void {
  if (process.platform !== 'win32') {
    overlayWindow?.showInactive();
    return;
  }

  if (!mpvPid || !Number.isInteger(mpvPid) || mpvPid <= 0) {
    overlayWindow?.showInactive();
    return;
  }

  const script = buildWindowBoundsScript(mpvPid);
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
      console.warn(`SentenceMiner overlay bounds watcher: ${message}`);
    }
  });
  boundsWatcher.on('exit', () => {
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

  if (!bounds.visible || bounds.width <= 0 || bounds.height <= 0) {
    overlayWindow.hide();
    return;
  }

  const nextKey = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
  if (nextKey !== lastBoundsKey) {
    lastBoundsKey = nextKey;
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
  overlayWindow.moveTop();
}

function buildWindowBoundsScript(pid: number): string {
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
}
"@
$targetPid = ${pid}
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
    $rect = New-Object Win32WindowBounds+RECT
    $point = New-Object Win32WindowBounds+POINT
    [Win32WindowBounds]::GetClientRect($script:found, [ref]$rect) | Out-Null
    [Win32WindowBounds]::ClientToScreen($script:found, [ref]$point) | Out-Null
    $payload = @{
      visible = $true
      x = $point.X
      y = $point.Y
      width = [Math]::Max(0, $rect.Right - $rect.Left)
      height = [Math]::Max(0, $rect.Bottom - $rect.Top)
    }
    $payload | ConvertTo-Json -Compress
  }
  Start-Sleep -Milliseconds 150
}
`;
}

function parseArgs(argv: string[]): OverlayArgs {
  return {
    helperUrl: readStringArg(argv, '--helper-url') || 'http://127.0.0.1:8766',
    mpvPid: readIntegerArg(argv, '--mpv-pid'),
    yomitanExtensionPath: readStringArg(argv, '--yomitan-extension-path') || '',
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

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
