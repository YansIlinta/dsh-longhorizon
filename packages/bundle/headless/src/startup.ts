/**
 * The one-shot app's command-line provider: it parses the task positional and
 * `--help`, then publishes {@link HEADLESS_STARTUP_SERVICE}. The runner is an
 * ordinary consumer whose lazy config waits for that service.
 * @module @deepseek-ai/dsh-headless/startup
 */

import { Command, InvalidArgumentError } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'headless-startup'

/** Services required before the task can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the one-shot runner. */
export const HEADLESS_STARTUP_SERVICE = 'headlessStartup'

/** What the runner row reads from {@link HEADLESS_STARTUP_SERVICE}. */
export interface HeadlessStartupValues {
  /** The task text this invocation asked for. */
  task: string
  /** Resume the persisted run with this session id instead of creating a fresh session. */
  resumeSessionId?: string
  /** Hard cap on agent steps for this run; overrides any config value. */
  maxSteps?: number
  /** Write the run's readable trajectory markdown to this path. */
  trajectoryPath?: string
}

/**
 * Validate the `--max-steps` value: a positive integer or a fail-loud parse
 * error that terminates the process.
 * @param value - the raw option value.
 * @returns the validated step cap.
 */
function parseMaxSteps(value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`--max-steps expects a positive integer, got ${JSON.stringify(value)}`)
  }
  return parsed
}

/**
 * This app's command: the task positional, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function headlessCommand(): Command {
  return new Command()
    .name('dsh --profile headless')
    .description('Answer one task, print the final assistant message, and exit.')
    .helpOption('-h, --help', 'show this help')
    .argument('[task...]', 'the task text; multiple words are joined by spaces')
    .option('--resume <sessionId>', 'resume the persisted run with this session id instead of creating a fresh session')
    .option('--max-steps <n>', 'hard cap on the number of agent steps for this run', parseMaxSteps)
    .option('--trajectory <path>', 'write the run as readable markdown to this path')
    .addHelpText('after', `
Examples:
  dsh --profile headless "run the tests"     answer one task and exit
  dsh --profile headless --resume session-abc --max-steps 40 "finish the leftover work"
  dsh --profile headless --trajectory out.md "<task text>"
`)
}

/**
 * Parse and provide the one-shot task as an ordinary Cordis service. The
 * command's action publishes the task; a missing or whitespace-only task is a
 * usage error, so on rejection (and on `--help`) nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = headlessCommand()
  program.action(() => {
    const task = program.args.join(' ')
    if (task.trim() === '') program.error('error: a task is required, for example: dsh --profile headless "run the tests"')
    const opts = program.opts() as { resume?: string; maxSteps?: number; trajectory?: string }
    const values: HeadlessStartupValues = { task }
    if (opts.resume !== undefined) values.resumeSessionId = opts.resume
    if (opts.maxSteps !== undefined) values.maxSteps = opts.maxSteps
    if (opts.trajectory !== undefined) values.trajectoryPath = opts.trajectory
    ctx.provide(HEADLESS_STARTUP_SERVICE, values)
  })
  parseCmdline(ctx, program)
}
