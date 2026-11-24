#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { constants } from 'node:os';
import type { Runtime } from '../../runtime/context.js';
import { errorText } from '../../shared/errors.js';
import {
  runCommand,
  type CommandContext,
  type CommandOptions,
} from './commands.js';
import { configureCliLogging, runtimeLogger } from './logging.js';

async function main(argv: string[]): Promise<number> {
  const ci = process.env.CI?.toLowerCase();
  const interactive =
    Boolean(
      process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY,
    ) &&
    (!ci || ci === '0' || ci === 'false');
  const controller = new AbortController();
  const logging = configureCliLogging(interactive);
  const abort = (signal: NodeJS.Signals = 'SIGINT'): void => {
    if (controller.signal.aborted)
      process.exit(128 + constants.signals[signal]);
    controller.abort(new Error('Interrupted'));
  };
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  try {
    return await run(argv, controller.signal);
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    logging.dispose();
  }

  async function run(
    args: string[],
    signal: AbortSignal,
    session?: { options: CommandOptions; write: (text: string) => void },
  ): Promise<number> {
    let runtime: Runtime | undefined;
    let display = session?.write;
    const context: CommandContext = {
      signal,
      defaults: session?.options,
      writeOut(text) {
        if (display) display(text);
        else process.stdout.write(text);
      },
      writeErr(text) {
        if (display) display(text);
        else process.stderr.write(text);
      },
      async openRuntime(pluginDirectories) {
        runtimeLogger.debug('Opening runtime');
        const { createRuntime } = await import('../../runtime/context.js');
        runtime = await createRuntime({ pluginDirectories });
        runtimeLogger.debug('Runtime ready');
        return runtime;
      },
      async releaseRuntime() {
        if (!runtime) return;
        const current = runtime;
        runtime = undefined;
        runtimeLogger.trace('Disposing runtime');
        await current.dispose();
      },
      dispatch(name, options, action) {
        return logging.run(options, async () => {
          if (!interactive || session || options.quiet) return action();
          const { runCommandApp } = await import('./ink-ui.js');
          return runCommandApp(name, logging, abort, async (write) => {
            display = write;
            try {
              return await action();
            } finally {
              display = undefined;
            }
          });
        });
      },
    };
    if (interactive && !session) {
      context.openShell = (options, commands) =>
        logging.run(options, async () => {
          const { runInteractiveShell } = await import('./ink-ui.js');
          return runInteractiveShell({
            options,
            commands,
            logging,
            signal,
            version: cliVersion(),
            workspace: process.cwd(),
            run: (words, commandSignal, defaults, write) =>
              run(words, commandSignal, { options: defaults, write }),
          });
        });
    }
    try {
      const result = await runCommand(args, context);
      if (result.stdout !== undefined) context.writeOut?.(result.stdout);
      return result.exitCode;
    } catch (error) {
      context.writeErr?.(`${errorText(error)}\n`);
      return signal.aborted ? 130 : 1;
    }
  }
}

function cliVersion(): string {
  const path = findPackageJSON(import.meta.url);
  if (!path) return 'unknown';
  const { version }: { version?: unknown } = JSON.parse(
    readFileSync(path, 'utf8'),
  );
  return typeof version === 'string' ? version : 'unknown';
}

process.exitCode = await main(process.argv.slice(2));
