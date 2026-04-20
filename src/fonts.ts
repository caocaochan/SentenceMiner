import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const LIST_INSTALLED_FONTS_SCRIPT = `
Add-Type -AssemblyName System.Drawing
[System.Drawing.Text.InstalledFontCollection]::new().Families |
  Select-Object -ExpandProperty Name
`;

export interface ListInstalledFontsOptions {
  platform?: NodeJS.Platform;
  execFileImpl?: typeof execFile;
}

export function normalizeInstalledFontNames(fonts: Iterable<string>): string[] {
  const uniqueFonts = new Map<string, string>();

  for (const font of fonts) {
    const trimmed = font.trim();
    if (!trimmed) {
      continue;
    }

    const normalizedKey = trimmed.toLocaleLowerCase();
    if (!uniqueFonts.has(normalizedKey)) {
      uniqueFonts.set(normalizedKey, trimmed);
    }
  }

  return [...uniqueFonts.values()].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
}

export function parseInstalledFontsOutput(output: string): string[] {
  return normalizeInstalledFontNames(output.split(/\r?\n/));
}

export async function listInstalledFonts(options: ListInstalledFontsOptions = {}): Promise<string[]> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    return [];
  }

  try {
    const exec = options.execFileImpl ?? execFile;
    const { stdout } = await exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', LIST_INSTALLED_FONTS_SCRIPT],
      {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
    );

    return parseInstalledFontsOutput(stdout);
  } catch {
    return [];
  }
}
