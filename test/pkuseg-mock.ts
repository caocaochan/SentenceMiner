import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

import { resetLearningTokenizerForTests } from '../src/learning-analysis.ts';

export async function useMockPkuseg(
  t: TestContext,
  options: {
    trackStarts?: boolean;
  } = {},
): Promise<{
  startLogPath: string | null;
}> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sentenceminer-pkuseg-mock-'));
  const mockPath = path.join(tempRoot, 'pkuseg-mock.mjs');
  const startLogPath = options.trackStarts ? path.join(tempRoot, 'starts.log') : null;
  const originalTokenizer = process.env.SENTENCEMINER_PKUSEG_TOKENIZER;
  const originalStartLog = process.env.PKUSEG_MOCK_START_LOG;

  await fs.writeFile(
    mockPath,
    [
      "import fs from 'node:fs';",
      "import readline from 'node:readline';",
      '',
      "const words = ['JavaScript', '喜欢', '学习', '中文', '我', '看', '读'];",
      'if (process.env.PKUSEG_MOCK_START_LOG) {',
      "  fs.appendFileSync(process.env.PKUSEG_MOCK_START_LOG, 'start\\n');",
      '}',
      '',
      'function segment(text) {',
      '  const segments = [];',
      '  for (let index = 0; index < text.length;) {',
      '    const match = words.find((word) => text.startsWith(word, index));',
      '    if (match) {',
      '      segments.push(match);',
      '      index += match.length;',
      '    } else {',
      '      segments.push(text[index]);',
      '      index += 1;',
      '    }',
      '  }',
      '  return segments;',
      '}',
      '',
      'const lines = readline.createInterface({ input: process.stdin });',
      "lines.on('line', (line) => {",
      '  try {',
      '    const request = JSON.parse(line);',
      '    const texts = Array.isArray(request.texts) ? request.texts : [];',
      '    const tokenizations = texts.map((text) => ({ segments: segment(String(text)) }));',
      '    process.stdout.write(`${JSON.stringify({ tokenizations })}\\n`);',
      '  } catch (error) {',
      '    process.stdout.write(`${JSON.stringify({ error: String(error) })}\\n`);',
      '  }',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );

  process.env.SENTENCEMINER_PKUSEG_TOKENIZER = mockPath;
  if (startLogPath) {
    process.env.PKUSEG_MOCK_START_LOG = startLogPath;
  } else {
    delete process.env.PKUSEG_MOCK_START_LOG;
  }
  resetLearningTokenizerForTests();

  t.after(async () => {
    resetLearningTokenizerForTests();
    restoreEnv('SENTENCEMINER_PKUSEG_TOKENIZER', originalTokenizer);
    restoreEnv('PKUSEG_MOCK_START_LOG', originalStartLog);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  return { startLogPath };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
