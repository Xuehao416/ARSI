import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { withContext, type LogRecord } from '@logtape/logtape';
import {
  completeShellCommand,
  runInteractiveShell,
} from '../../src/entries/cli/ink-ui.js';
import {
  cliLogger,
  configureCliLogging,
  parseLogLevels,
  runtimeLogger,
} from '../../src/entries/cli/logging.js';
import {
  parseShellLine,
  splitCommandLine,
} from '../../src/entries/cli/shell-parser.js';

class TerminalInput extends Socket {
  readonly isTTY = true;
  isRaw = false;

  override _read(): void {}

  setRawMode(enabled: boolean): this {
    this.isRaw = enabled;
    return this;
  }
}

test('LogTape filters output by category, retains MDC, and routes UI logs away from stderr', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'arsi-ink-logs-'));
  const logFile = join(root, 'cli.log');
  const terminal: string[] = [];
  const logging = configureCliLogging(false, (text) => terminal.push(text));
  t.after(() => logging.dispose());
  t.after(() => rm(root, { recursive: true, force: true }));

  const levels = parseLogLevels('cli.runtime=trace', parseLogLevels('warn'));
  const records: LogRecord[] = [];
  const release = logging.takeTerminal((record) => records.push(record));
  try {
    await logging.run({ logFile, logLevel: levels }, () =>
      withContext({ command: 'doctor' }, async () => {
        await Promise.resolve();
        cliLogger.info('filtered');
        runtimeLogger.trace('runtime detail');
        cliLogger.warn('visible warning');
      }),
    );
    assert.deepEqual(terminal, []);
    assert.deepEqual(
      records.map(({ level, properties }) => [level, properties.command]),
      [
        ['trace', 'doctor'],
        ['warning', 'doctor'],
      ],
    );
  } finally {
    release();
  }

  await logging.run(
    { logFile, logLevel: parseLogLevels('debug', levels) },
    async () => {
      cliLogger.debug('after level change');
    },
  );
  assert.match(terminal.join(''), /DEBUG.*after level change/);
  const saved = await readFile(logFile, 'utf8');
  assert.match(saved, /TRACE.*runtime detail \[command=doctor\]/);
  assert.match(saved, /WARN.*visible warning/);
  assert.match(saved, /DEBUG.*after level change/);
  assert.doesNotMatch(saved, /filtered/);
});

test('shell syntax preserves quoted arguments and Windows paths and completes command names', () => {
  assert.deepEqual(
    splitCommandLine(
      String.raw`run "C:\My Recipes\test.yaml" --id 'test run' --plugin-dir ""`,
    ),
    [
      'run',
      'C:\\My Recipes\\test.yaml',
      '--id',
      'test run',
      '--plugin-dir',
      '',
    ],
  );
  assert.deepEqual(parseShellLine('arsi  log-level  cli=trace'), {
    kind: 'builtin',
    name: 'log-level',
    args: ['cli=trace'],
  });
  assert.deepEqual(parseShellLine('   '), { kind: 'empty' });
  assert.throws(
    () => parseShellLine(`run 'unterminated`),
    /Unclosed single quote/,
  );
  assert.equal(
    completeShellCommand('ref', ['reflection', 'reflection list']),
    'reflection',
  );
  assert.equal(
    completeShellCommand('reflection li', ['reflection', 'reflection list']),
    'reflection list ',
  );
});

test('Ink shell supports Tab, history, runtime cancellation, and a live log level', async (t) => {
  const logging = configureCliLogging(true);
  t.after(() => logging.dispose());
  const session = new AbortController();
  const stdin = new TerminalInput();
  const stdout = Object.assign(new Socket(), {
    isTTY: true,
    columns: 100,
    rows: 30,
  });
  let screen = '';
  stdout._write = (buffer: Buffer, _encoding, done) => {
    screen += buffer.toString();
    done();
  };
  const calls: string[][] = [];
  const shell = runInteractiveShell(
    {
      options: { pluginDir: [] },
      commands: ['catalog', 'dashboard'],
      logging,
      signal: session.signal,
      version: '1.2.3',
      workspace: '/test-workspace',
      async run(argv, signal, options, write) {
        calls.push(argv);
        if (argv[0] === 'dashboard') {
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else
              signal.addEventListener('abort', () => resolve(), { once: true });
          });
          write('Command interrupted');
          return 130;
        }
        write(`Catalog output at ${options.logLevel?.level ?? 'info'}`);
        return 0;
      },
    },
    {
      stdin,
      stdout: stdout as NodeJS.WriteStream,
      patchConsole: false,
      kittyKeyboard: { mode: 'disabled' },
    },
  );

  async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return;
      await setTimeout(30);
    }
    assert.fail(
      `Expected terminal update. Last output: ${JSON.stringify(screen.slice(-500))}`,
    );
  }

  try {
    await waitFor(() => screen.includes('Workspace /test-workspace'));
    stdin.push('cat');
    await waitFor(() => screen.includes('cat'));
    stdin.push('\t');
    await waitFor(() => screen.includes('catalog'));
    stdin.push('\r');
    await waitFor(() => screen.includes('Catalog output at info'));
    stdin.push('\x1b[A');
    await setTimeout(50);
    stdin.push('\r');
    await waitFor(() => calls.length === 2);
    assert.deepEqual(calls, [['catalog'], ['catalog']]);

    stdin.push('log-level debug');
    await waitFor(() => screen.includes('log-level debug'));
    stdin.push('\r');
    await waitFor(() => screen.includes('Ready · DEBUG'));

    stdin.push('dashboard');
    await waitFor(() => screen.includes('dashboard'));
    stdin.push('\r');
    await waitFor(() => calls.length === 3);
    stdin.push('\x03');
    await waitFor(() => screen.includes('Command interrupted'));
    assert.equal(session.signal.aborted, false);
    stdin.push('\x03');
    assert.equal(await shell, 0);
  } finally {
    session.abort();
    await shell;
    stdin.destroy();
    stdout.destroy();
  }
});
