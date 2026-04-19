import { spawn } from 'node:child_process';

import type { ServerConfig } from './types.ts';

export interface BrowserLaunchCommand {
  command: string;
  args: string[];
}

export function buildAppUrl(server: ServerConfig): string {
  const host = normalizeBrowserHost(server.host);
  return `http://${host}:${server.port}`;
}

export function normalizeBrowserHost(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host === '::0' || host === '') {
    return '127.0.0.1';
  }

  return host;
}

export function buildBrowserLaunchCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): BrowserLaunchCommand | null {
  switch (platform) {
    case 'win32':
      return {
        command: process.env.ComSpec || 'cmd.exe',
        args: ['/c', 'start', '', url],
      };
    case 'darwin':
      return {
        command: 'open',
        args: [url],
      };
    case 'linux':
      return {
        command: 'xdg-open',
        args: [url],
      };
    default:
      return null;
  }
}

export function openUrlInBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
  const launchCommand = buildBrowserLaunchCommand(url, platform);
  if (!launchCommand) {
    return false;
  }

  const child = spawn(launchCommand.command, launchCommand.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });

  child.unref();
  return true;
}
