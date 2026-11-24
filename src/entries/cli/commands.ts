import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { aborted } from 'node:util';
import { withContext } from '@logtape/logtape';
import {
  Argument,
  Command,
  InvalidArgumentError,
  type CommanderError,
} from 'commander';
import type { Runtime } from '../../runtime/context.js';
import type { RevisionApplication } from '../../runtime/revisions/application.js';
import {
  errorText,
  RuntimeCleanupInterruptedError,
} from '../../shared/errors.js';
import {
  cliLogger,
  logDiagnostic,
  parseLogLevels,
  type LogOptions,
} from './logging.js';

export interface CommandOptions extends LogOptions {
  pluginDir: string[];
}

export interface CommandContext {
  signal: AbortSignal;
  openRuntime(pluginDirectories: string[]): Promise<Runtime>;
  releaseRuntime(): Promise<void>;
  defaults?: CommandOptions;
  writeOut?(text: string): void;
  writeErr?(text: string): void;
  dispatch?(
    name: string,
    options: CommandOptions,
    execute: () => Promise<CommandResult>,
  ): Promise<CommandResult>;
  openShell?(options: CommandOptions, commands: string[]): Promise<number>;
}

export interface CommandResult {
  exitCode: number;
  stdout?: string;
}

export async function runCommand(
  argv: string[],
  context: CommandContext,
): Promise<CommandResult> {
  let result: { exitCode: number; json?: unknown } | undefined;
  let outcome: CommandResult | undefined;
  let commanderExit: CommanderError | undefined;
  const writeOut =
    context.writeOut ??
    ((text) => {
      process.stdout.write(text);
    });
  const writeErr =
    context.writeErr ??
    ((text) => {
      process.stderr.write(text);
    });
  const program = new Command('arsi')
    .description('Make everything rsi-able')
    .allowExcessArguments(false)
    .showHelpAfterError()
    .configureOutput({ writeOut, writeErr })
    .exitOverride((error) => {
      commanderExit = error;
      throw error;
    })
    .option(
      '--plugin-dir <directory>',
      'Load extensions from a directory (repeatable)',
      (value: string, previous: string[]) => [...previous, value],
      context.defaults?.pluginDir ?? [],
    )
    .option(
      '--log-level <level|category=level>',
      'Set the log level or override a dotted log category (repeatable)',
      parseLogLevels,
      context.defaults?.logLevel,
    )
    .option(
      '--log-file <path>',
      'Append logs to a file',
      context.defaults?.logFile,
    )
    .option(
      '-q, --quiet',
      'Show only errors and command output',
      context.defaults?.quiet,
    )
    .addHelpText(
      'after',
      '\nRun facts are saved in .rsi/ under the current directory.\nExtensions load from ~/.arsi/plugins/<name>/index.mjs by default.\nEach plugin directory must contain index.mjs exporting register(registry).',
    );
  const openRuntime = (): Promise<Runtime> =>
    context.openRuntime(program.opts<CommandOptions>().pluginDir);
  const runJson = async (
    execute: (runtime: Runtime) => unknown,
  ): Promise<void> => {
    const runtime = await openRuntime();
    result = { exitCode: 0, json: await execute(runtime) };
  };

  function action<Args extends unknown[]>(
    handler: (...args: Args) => void | Promise<void>,
  ) {
    return async (...args: Args): Promise<void> => {
      const command = args.at(-1);
      if (!(command instanceof Command))
        throw new Error('Missing command context');
      const name = commandPath(command);
      const execute = async (): Promise<CommandResult> => {
        await handler(...args);
        if (!result) throw new Error(`No result from ${name}`);
        return 'json' in result
          ? {
              exitCode: result.exitCode,
              stdout: JSON.stringify(result.json, null, 2) + '\n',
            }
          : result;
      };
      outcome = context.dispatch
        ? await context.dispatch(name, program.opts<CommandOptions>(), () =>
            executeWithLogging(name, context, execute),
          )
        : await execute();
    };
  }

  program
    .command('run <recipe.yaml>')
    .description('Run or resume an experiment')
    .option('--id <experiment-id>', 'Set the experiment ID')
    .option('--resume', 'Resume an experiment using a compatible Recipe')
    .hook('preAction', (_program, command) => {
      const { id, resume } = command.opts<{ id?: string; resume?: boolean }>();
      if (resume && !id) command.error('--resume requires --id');
    })
    .action(action(runExperiment));
  program
    .command('doctor <recipe.yaml>')
    .description('Check experiment configuration and runtime prerequisites')
    .option('--static', 'Check configuration and declared local paths only')
    .action(action(runDoctor));
  program
    .command('list')
    .description('List experiments, plugins, or policies')
    .addArgument(
      new Argument('[kind]').choices([
        'plugin',
        'plugins',
        'policy',
        'policies',
      ]),
    )
    .action(action(list));
  program
    .command('show <experiment-id>')
    .description('Show an experiment')
    .action(action((id: string) => runJson(({ manager }) => manager.get(id))));
  program
    .command('cancel <experiment-id>')
    .description('Cancel an experiment')
    .action(action(cancelExperiment));
  program
    .command('cleanup [experiment-id]')
    .description(
      'Clean up a saved experiment or preview all experiments in this workspace',
    )
    .option(
      '--all',
      'Clean up all experiments in this workspace, skipping any in use',
    )
    .option(
      '--dry-run',
      'Preview eligible resources and reasons for retaining others',
    )
    .addHelpText(
      'after',
      '\nWith no ID or flags, cleanup previews the workspace. Checkpoints, results and logs are kept for --resume. Required images may be pulled or built again.',
    )
    .hook('preAction', (_program, command) => {
      if (
        command.args[0] !== undefined &&
        command.opts<{ all?: boolean }>().all
      )
        command.error('--all cannot be combined with an experiment ID');
    })
    .action(action(cleanup));
  const reflection = program
    .command('reflection')
    .description('Inspect and apply reflection revisions');
  reflection
    .command('list [experiment-id]')
    .description('List reflection revisions')
    .action(action(forRevision((revisions, id) => revisions.list(id))));
  reflection
    .command('show <revisionID>')
    .description('Show reflection revisions')
    .action(
      action(forRevision((revisions, id) => revisions.show(requireId(id)))),
    );
  reflection
    .command('apply <revisionID>')
    .description('Apply reflection revisions')
    .action(
      action(forRevision((revisions, id) => revisions.apply(requireId(id)))),
    );
  program
    .command('catalog')
    .description('Show registered contracts, plugins, and policies')
    .action(action(() => runJson(({ registry }) => registry.catalog())));
  program
    .command('dashboard')
    .description('Start the dashboard on localhost')
    .option(
      '--port <port>',
      'Listening port (1..65535)',
      (value: string) => {
        const port = Number(value);
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
          throw new InvalidArgumentError('port must be 1..65535');
        return port;
      },
      4317,
    )
    .action(action(startDashboard));

  const shell = program
    .command('shell')
    .description('Open the interactive CLI');
  shell.action(async () => {
    if (!context.openShell) {
      shell.error(
        context.defaults
          ? 'Already in the interactive CLI'
          : 'The interactive CLI requires a terminal outside CI',
      );
      return;
    }
    const commands = program.commands.flatMap((command) => [
      command.name(),
      ...command.commands.map(commandPath),
    ]);
    outcome = {
      exitCode: await context.openShell(
        program.opts<CommandOptions>(),
        commands,
      ),
    };
  });

  function runExperiment(
    file: string,
    { id, resume = false }: { id?: string; resume?: boolean },
  ): Promise<void> {
    return runJson(({ manager }) =>
      manager.run(resolve(file), { id, resume, signal: context.signal }),
    );
  }

  async function runDoctor(
    file: string,
    options: { static?: boolean },
  ): Promise<void> {
    const { checkRecipe } = await import(
      '../../runtime/doctor/check-recipe.js'
    );
    const report = await checkRecipe(file, {
      signal: context.signal,
      staticOnly: options.static ?? false,
      openRuntime,
      releaseRuntime: context.releaseRuntime,
    });
    result = { exitCode: report.summary.failed > 0 ? 1 : 0, json: report };
  }

  function list(kind: string | undefined): Promise<void> {
    return runJson(async ({ manager, registry }) => {
      if (!kind) return manager.list();
      const { describeCatalog } = await import('./catalog.js');
      const catalog = await describeCatalog(registry);
      return kind === 'plugin' || kind === 'plugins'
        ? catalog.plugins
        : catalog.policies;
    });
  }

  function cancelExperiment(id: string): Promise<void> {
    return runJson(async ({ manager }) => {
      await manager.cancel(id);
      return { id, cancellationRequested: true };
    });
  }

  async function cleanup(
    id: string | undefined,
    { dryRun = false, all = false }: { dryRun?: boolean; all?: boolean },
  ): Promise<void> {
    const { manager } = await openRuntime();
    const { cleanupExperiment, cleanupWorkspace } = await import(
      './cleanup.js'
    );
    const report =
      id === undefined
        ? await cleanupWorkspace(manager, dryRun || !all, context.signal)
        : await cleanupExperiment(manager, id, dryRun, context.signal);
    const incomplete =
      'experiments' in report
        ? report.experiments.some(
            ({ status }) => status === 'pending' || status === 'failed',
          )
        : report.results.some(({ status }) => status === 'pending');
    result = {
      exitCode: context.signal.aborted ? 130 : incomplete ? 1 : 0,
      json: report,
    };
  }

  function forRevision(
    execute: (revisions: RevisionApplication, id?: string) => Promise<unknown>,
  ): (id?: string) => Promise<void> {
    return (id) =>
      runJson(({ manager }) => execute(manager.reflection(), id || undefined));
  }

  function requireId(id?: string): string {
    if (!id) throw new Error('Revision ID is required');
    return id;
  }

  async function startDashboard({ port }: { port: number }): Promise<void> {
    if (!statSync('.rsi', { throwIfNoEntry: false })?.isDirectory())
      throw new Error(
        'Dashboard requires a .rsi directory in the current working directory. Run it from your experiment workspace.',
      );
    const runtime = await openRuntime();
    const { createServer } = await import('../web/server.js');
    const server = await createServer(runtime);
    const address = await server.listen({ host: '127.0.0.1', port });
    writeOut(`Dashboard open at ${address}\n`);
    try {
      await aborted(context.signal, server);
    } finally {
      await server.close();
    }
    result = { exitCode: 0 };
  }

  try {
    await program.parseAsync(
      argv.length ? argv : [context.openShell ? 'shell' : '--help'],
      { from: 'user' },
    );
  } catch (error) {
    if (commanderExit === undefined || error !== commanderExit) throw error;
    return { exitCode: commanderExit.exitCode === 0 ? 0 : 2 };
  }
  if (!outcome)
    throw new Error('Choose a subcommand; use --help for available commands');
  return outcome;
}

function commandPath(command: Command): string {
  return command.parent?.parent
    ? `${commandPath(command.parent)} ${command.name()}`
    : command.name();
}

function executeWithLogging(
  name: string,
  context: CommandContext,
  execute: () => Promise<CommandResult>,
): Promise<CommandResult> {
  return withContext({ command: name }, async () => {
    const start = performance.now();
    let result: CommandResult = { exitCode: 0 };
    try {
      cliLogger.info('Starting {command}');
      result = await execute();
    } catch (error) {
      result = { exitCode: context.signal.aborted ? 130 : 1 };
      if (error instanceof RuntimeCleanupInterruptedError) {
        logDiagnostic(errorText(error.interruption));
        logDiagnostic(`Failed to dispose runtime: ${errorText(error.cause)}`);
      } else {
        logDiagnostic(errorText(error));
      }
    } finally {
      try {
        await context.releaseRuntime();
      } catch (error) {
        result.exitCode ||= 1;
        logDiagnostic(`Failed to dispose runtime: ${errorText(error)}`);
      }
    }
    cliLogger.info(
      'Finished {command} with exit code {exitCode} in {elapsedMs} ms',
      {
        exitCode: result.exitCode,
        elapsedMs: Math.round(performance.now() - start),
      },
    );
    return result;
  });
}
