import { setImmediate } from 'node:timers/promises';
import { Spinner, TextInput } from '@inkjs/ui';
import type { LogRecord, LogLevel } from '@logtape/logtape';
import {
  Box,
  Static,
  Text,
  render,
  useApp,
  useInput,
  type RenderOptions,
} from 'ink';
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { errorText } from '../../shared/errors.js';
import type { CommandOptions, CommandResult } from './commands.js';
import {
  logLineParts,
  parseLogLevels,
  terminalLogLevel,
  type CliLogging,
} from './logging.js';
import { parseShellLine, shellBuiltins, shellHelp } from './shell-parser.js';

const art = String.raw`    _    ____  ____ ___
   / \  |  _ \/ ___|_ _|
  / _ \ | |_) \___ \| |
 / ___ \|  _ < ___) | |
/_/   \_\_| \_\____/___|`;

function Banner({
  version,
  workspace,
  level,
}: {
  version: string;
  workspace: string;
  level: string;
}) {
  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      flexDirection="column"
    >
      <Text bold color="cyan">
        {art}
      </Text>
      <Text>ARSI {version}</Text>
      <Text dimColor>Workspace {workspace}</Text>
      <Text dimColor>Log level {level}</Text>
    </Box>
  );
}

const colors: Record<LogLevel, string> = {
  trace: 'gray',
  debug: 'blue',
  info: 'green',
  warning: 'yellow',
  error: 'red',
  fatal: 'magenta',
};

function LogLine({ record }: { record: LogRecord }) {
  const { timestamp, level, category, message } = logLineParts(record);
  return (
    <Text>
      <Text dimColor>{timestamp} </Text>
      <Text color={colors[record.level]}>{level}</Text>
      <Text dimColor> {process.pid} --- </Text>
      <Text color="cyan">{category}</Text>
      {' : '}
      {message}
    </Text>
  );
}

function createTranscript(initial: ReactNode[] = []) {
  const listeners = new Set<() => void>();
  let items = initial;
  const append = (node: ReactNode): void => {
    items = [...items, node];
    for (const listener of listeners) listener();
  };
  return {
    append,
    write(text: string) {
      append(<Text>{text.replace(/\r?\n$/, '')}</Text>);
    },
    log(record: LogRecord) {
      append(<LogLine record={record} />);
    },
    snapshot: () => items,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

type Transcript = ReturnType<typeof createTranscript>;

function useElapsed(start?: number): string {
  const [, tick] = useState(0);
  useEffect(() => {
    if (start === undefined) return;
    const timer = setInterval(() => tick((frame) => frame + 1), 100);
    return () => clearInterval(timer);
  }, [start]);
  return start === undefined
    ? ''
    : `${((performance.now() - start) / 1000).toFixed(1)}s`;
}

function CommandApp({
  command,
  transcript,
  start,
  interrupt,
  result,
}: {
  command: string;
  transcript: Transcript;
  start: number;
  interrupt: () => void;
  result?: CommandResult;
}) {
  const items = useSyncExternalStore(transcript.subscribe, transcript.snapshot);
  const elapsed = useElapsed(result ? undefined : start);
  useInput((input, key) => {
    if (key.ctrl && input === 'c') interrupt();
  });
  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item, index) => <Box key={index}>{item}</Box>}
      </Static>
      {result ? (
        <Text color={result.exitCode === 0 ? 'green' : 'red'}>
          {result.exitCode === 0 ? 'Completed' : `Exit ${result.exitCode}`}{' '}
          {command} · {((performance.now() - start) / 1000).toFixed(1)}s
        </Text>
      ) : (
        <Spinner label={`Executing ${command} · ${elapsed}`} />
      )}
    </Box>
  );
}

interface ShellProps {
  options: CommandOptions;
  commands: string[];
  logging: CliLogging;
  signal: AbortSignal;
  version: string;
  workspace: string;
  run(
    argv: string[],
    signal: AbortSignal,
    options: CommandOptions,
    write: (text: string) => void,
  ): Promise<number>;
}

export function completeShellCommand(
  line: string,
  commands: readonly string[],
): string {
  const prefix = line.trimStart();
  const matches = [...new Set([...commands, ...shellBuiltins])].filter(
    (command) => command.startsWith(prefix),
  );
  if (matches.length === 1) return `${matches[0]} `;
  if (matches.includes(prefix)) return `${prefix} `;
  let common = matches[0] ?? prefix;
  for (const match of matches.slice(1)) {
    while (!match.startsWith(common)) common = common.slice(0, -1);
  }
  return common === prefix ? line : common;
}

function InteractiveShellApp({
  options,
  commands,
  signal,
  run,
  transcript,
  history,
}: ShellProps & {
  transcript: Transcript;
  history: string[];
}) {
  const { exit } = useApp();
  const items = useSyncExternalStore(transcript.subscribe, transcript.snapshot);
  const [input, setInput] = useState({ revision: 0, text: '' });
  const current = useRef('');
  const draft = useRef('');
  const historyIndex = useRef(history.length);
  const active = useRef<AbortController>(undefined);
  const [running, setRunning] = useState<{ command: string; start: number }>();
  const [level, setLevel] = useState(terminalLogLevel(options, true));
  const elapsed = useElapsed(running?.start);

  useEffect(() => {
    const abort = (): void => {
      if (active.current) active.current.abort(signal.reason);
      else exit();
    };
    if (signal.aborted) abort();
    signal.addEventListener('abort', abort, { once: true });
    return () => signal.removeEventListener('abort', abort);
  }, [exit, signal]);

  function replaceInput(text: string): void {
    current.current = text;
    setInput(({ revision }) => ({ revision: revision + 1, text }));
  }

  useInput((keyInput, key) => {
    if (key.ctrl && keyInput === 'c') {
      if (active.current?.signal.aborted) process.exit(130);
      if (active.current) {
        active.current.abort(new Error('Interrupted'));
        transcript.write('Interrupt requested');
      } else exit();
      return;
    }
    if (active.current) return;
    if (key.tab) replaceInput(completeShellCommand(current.current, commands));
    else if (key.upArrow || key.downArrow) {
      if (historyIndex.current === history.length)
        draft.current = current.current;
      historyIndex.current = Math.max(
        0,
        Math.min(history.length, historyIndex.current + (key.upArrow ? -1 : 1)),
      );
      replaceInput(history[historyIndex.current] ?? draft.current);
    }
  });

  async function submit(line: string): Promise<void> {
    if (active.current || !line.trim()) return;
    history.push(line);
    historyIndex.current = history.length;
    replaceInput('');
    transcript.append(
      <Text>
        <Text bold color="cyan">
          ❯{' '}
        </Text>
        {line}
      </Text>,
    );
    let argv: string[];
    try {
      const parsed = parseShellLine(line);
      if (parsed.kind === 'empty') return;
      if (parsed.kind === 'builtin') {
        const { name, args } = parsed;
        if (name === 'help') {
          if (!args.length) transcript.write(shellHelp);
          argv = [...args, '--help'];
        } else {
          if (args.length > (name === 'log-level' ? 1 : 0))
            throw new Error(
              `Usage: ${name}${name === 'log-level' ? ' [level|category=level]' : ''}`,
            );
          if (name === 'exit') exit();
          else if (name === 'clear') exit('clear');
          else {
            if (args[0])
              options.logLevel = parseLogLevels(args[0], options.logLevel);
            const next = terminalLogLevel(options, true);
            setLevel(next);
            const modules = [...(options.logLevel?.modules ?? [])].map(
              ([category, level]) => `${category}=${level}`,
            );
            transcript.write([`Log level ${next}`, ...modules].join('\n'));
          }
          return;
        }
      } else argv = parsed.argv;
    } catch (error) {
      transcript.write(errorText(error));
      return;
    }

    const controller = new AbortController();
    active.current = controller;
    setRunning({ command: argv[0], start: performance.now() });
    try {
      await run(
        argv,
        AbortSignal.any([signal, controller.signal]),
        options,
        transcript.write,
      );
    } catch (error) {
      transcript.write(errorText(error));
    } finally {
      active.current = undefined;
      if (signal.aborted) exit();
      else setRunning(undefined);
    }
  }

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item, index) => <Box key={index}>{item}</Box>}
      </Static>
      {running ? (
        <Spinner label={`Executing ${running.command} · ${elapsed}`} />
      ) : (
        <Text dimColor>Ready · {level.toUpperCase()}</Text>
      )}
      <Box>
        <Text bold color="cyan">
          ❯{' '}
        </Text>
        <TextInput
          key={input.revision}
          defaultValue={input.text}
          isDisabled={Boolean(running)}
          placeholder="Type a command"
          onChange={(text) => {
            current.current = text;
          }}
          onSubmit={(line) => {
            void submit(line);
          }}
        />
      </Box>
    </Box>
  );
}

const renderOptions: RenderOptions = {
  stdout: process.stderr,
  exitOnCtrlC: false,
};

export async function runCommandApp(
  command: string,
  logging: CliLogging,
  interrupt: () => void,
  execute: (write: (text: string) => void) => Promise<CommandResult>,
): Promise<CommandResult> {
  const transcript = createTranscript();
  const start = performance.now();
  const release = logging.takeTerminal(transcript.log);
  try {
    const app = render(
      <CommandApp {...{ command, transcript, start, interrupt }} />,
      renderOptions,
    );
    try {
      const result = await execute(transcript.write);
      app.rerender(
        <CommandApp {...{ command, transcript, start, interrupt, result }} />,
      );
      return result;
    } finally {
      await setImmediate();
      const closed = app.waitUntilExit();
      app.unmount();
      await closed;
    }
  } finally {
    release();
  }
}

export async function runInteractiveShell(
  props: ShellProps,
  streams: RenderOptions = {},
): Promise<number> {
  const { version, workspace, options, logging, signal } = props;
  const history: string[] = [];
  while (!signal.aborted) {
    const level = terminalLogLevel(options, true);
    const transcript = createTranscript([
      <Banner {...{ version, workspace, level }} />,
    ]);
    const release = logging.takeTerminal(transcript.log);
    try {
      const app = render(
        <InteractiveShellApp {...props} {...{ history, transcript }} />,
        { ...renderOptions, ...streams },
      );
      try {
        if ((await app.waitUntilExit()) !== 'clear')
          return signal.aborted ? 130 : 0;
      } finally {
        app.unmount();
      }
    } finally {
      release();
    }
    (streams.stdout ?? process.stderr).write('\x1b[2J\x1b[3J\x1b[H');
  }
  return 130;
}
