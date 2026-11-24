import { AsyncLocalStorage } from 'node:async_hooks';
import { closeSync, openSync, writeSync } from 'node:fs';
import {
  compareLogLevel,
  configureSync,
  getLogger,
  getTextFormatter,
  resetSync,
  type LogLevel,
  type LogRecord,
} from '@logtape/logtape';
import { InvalidArgumentError } from 'commander';

const levels = [
  'trace',
  'debug',
  'info',
  'warning',
  'error',
  'fatal',
  'off',
] as const;
type CliLogLevel = (typeof levels)[number];

export interface LogLevels {
  level?: CliLogLevel;
  modules?: ReadonlyMap<string, CliLogLevel>;
}

export interface LogOptions {
  logLevel?: LogLevels;
  logFile?: string;
  quiet?: boolean;
}

export const cliLogger = getLogger(['arsi', 'cli']);
export const runtimeLogger = cliLogger.getChild('runtime');

export function parseLogLevels(
  value: string,
  previous: LogLevels = {},
): LogLevels {
  const separator = value.indexOf('=');
  const name = value.slice(separator + 1).toLowerCase();
  const level = levels.find(
    (entry) => entry === (name === 'warn' ? 'warning' : name),
  );
  if (!level)
    throw new InvalidArgumentError(
      'Expected trace, debug, info, warn, error, fatal, or off',
    );
  if (separator < 0) return { ...previous, level };

  const category = value.slice(0, separator);
  if (!/^[\w-]+(?:\.[\w-]+)*$/.test(category))
    throw new InvalidArgumentError('Expected a dot-separated log category');
  const path =
    category === 'arsi' || category.startsWith('arsi.')
      ? category
      : `arsi.${category}`;
  return { ...previous, modules: new Map(previous.modules).set(path, level) };
}

function moduleLevel(
  category: readonly string[],
  settings?: LogLevels,
): CliLogLevel | undefined {
  if (!settings?.modules) return undefined;
  for (let length = category.length; length > 0; length--) {
    const level = settings.modules.get(category.slice(0, length).join('.'));
    if (level !== undefined) return level;
  }
  return undefined;
}

export function terminalLogLevel(
  options: LogOptions,
  interactive: boolean,
): CliLogLevel {
  return options.logLevel?.level ?? (interactive ? 'info' : 'warning');
}

const labels: Record<LogLevel, string> = {
  trace: 'TRACE',
  debug: 'DEBUG',
  info: 'INFO',
  warning: 'WARN',
  error: 'ERROR',
  fatal: 'FATAL',
};

const formatMessage = getTextFormatter({
  format: ({ message }) => message,
  value: 'bare',
});

export function logLineParts(record: LogRecord): {
  timestamp: string;
  level: string;
  category: string;
  message: string;
} {
  const { command } = record.properties;
  return {
    timestamp: new Date(record.timestamp).toISOString(),
    level: labels[record.level].padStart(5),
    category: record.category.join('.'),
    message:
      formatMessage(record).trimEnd() +
      (typeof command === 'string' ? ` [command=${command}]` : ''),
  };
}

export function formatLogLine(record: LogRecord): string {
  const { timestamp, level, category, message } = logLineParts(record);
  return `${timestamp} ${level} ${process.pid} --- ${category} : ${message}\n`;
}

/** Command errors are also user-facing diagnostics, even when logging is off. */
export function logDiagnostic(message: string): void {
  cliLogger.error('{message}', { message, cliDiagnostic: true });
}

export interface CliLogging {
  run<T>(options: LogOptions, execute: () => Promise<T>): Promise<T>;
  takeTerminal(sink: (record: LogRecord) => void): () => void;
  dispose(): void;
}

function accepts(record: LogRecord, level: CliLogLevel): boolean {
  return level !== 'off' && compareLogLevel(record.level, level) >= 0;
}

export function configureCliLogging(
  interactive: boolean,
  write = (text: string): void => {
    process.stderr.write(text);
  },
): CliLogging {
  const invocation = new AsyncLocalStorage<{
    options: LogOptions;
    file?: number;
  }>();
  let terminalSink: ((record: LogRecord) => void) | undefined;
  configureSync({
    contextLocalStorage: new AsyncLocalStorage(),
    sinks: {
      cli(record) {
        const scope = invocation.getStore();
        const options = scope?.options ?? {};
        const override = moduleLevel(record.category, options.logLevel);
        if (
          scope?.file !== undefined &&
          accepts(record, override ?? options.logLevel?.level ?? 'debug')
        )
          writeSync(scope.file, formatLogLine(record));

        const diagnostic = record.properties.cliDiagnostic === true;
        if (
          !diagnostic &&
          (!accepts(
            record,
            override ?? terminalLogLevel(options, interactive),
          ) ||
            (options.quiet && !accepts(record, 'error')))
        )
          return;
        if (terminalSink) terminalSink(record);
        else if (diagnostic && !interactive && !options.logLevel)
          write(`${String(record.properties.message)}\n`);
        else write(formatLogLine(record));
      },
    },
    loggers: [
      { category: ['arsi'], lowestLevel: 'trace', sinks: ['cli'] },
      { category: ['logtape', 'meta'], lowestLevel: null },
    ],
  });
  return {
    async run<T>(options: LogOptions, execute: () => Promise<T>): Promise<T> {
      const file =
        options.logFile === undefined
          ? undefined
          : openSync(options.logFile, 'a', 0o600);
      const scope = { options, file };
      try {
        return await invocation.run(scope, execute);
      } finally {
        scope.file = undefined;
        if (file !== undefined) closeSync(file);
      }
    },
    takeTerminal(sink) {
      terminalSink = sink;
      return () => {
        if (terminalSink === sink) terminalSink = undefined;
      };
    },
    dispose: resetSync,
  };
}
