/**
 * dsh-git-bug — git-bug issues for the current workspace.
 *
 * One plugin activation owns one repository (config `repoPath`, default: the
 * harness process working directory). It contributes three things:
 *
 * 1. the `git_bug_*` tool family, so the agent can read and write issues;
 * 2. a system-prompt section that states how to use them and shows the live
 *    board, so the agent treats issues as its shared, persistent task list;
 * 3. a same-origin JSON API under `apiPath`, which the browser half (the
 *    Issues panel) drives.
 *
 * The `git-bug` executable is an external dependency: it is resolved through
 * the subprocess capability and reported in the prompt when missing.
 * @module dsh-git-bug
 */

import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { createBoard } from '../board.js'
import { createGitBug } from '../git-bug.js'
import { createAvailabilityProbe, createSubprocessRunner } from '../subprocess-runner.js'
import { createApiHandler } from './api.js'
import { renderPromptSection, SECTION_NAME } from './prompt.js'
import { registerTools } from './tools.js'

/** Plugin name reported by Cordis. */
export const name = 'dsh-git-bug'

/** Services this plugin reads: the tool registry, the prompt registry, and subprocess execution. */
export const inject = ['tools', 'systemPrompt', 'subprocess']

/** Default mount point of the JSON API the browser half calls. */
export const DEFAULT_API_PATH = '/git-bug/v1'

/** Default label that marks agent-owned tasks in the shared task list. */
export const DEFAULT_TASK_LABEL = 'agent-task'

/** Default identity created in repositories that have none. */
export const DEFAULT_IDENTITY = { name: 'DeepSeek Harness', email: 'harness@localhost' }

/**
 * Upper bound on how long activation waits for the first board read. The
 * system prompt carries the issue list, so the first turn should see it, but a
 * repository that is slow (or a git-bug held by a stale lock) must not stall
 * profile boot: after this bound the load finishes in the background and later
 * assemblies pick it up.
 */
export const WARMUP_CAP_MS = 3000

/** Expand a leading "~/" and resolve against the process working directory. */
function expandPath(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2))
  return resolve(value)
}

/** Read a positive finite number from config, or throw with the field name. */
function positiveNumber(value, field, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`dsh-git-bug: config.${field} must be a positive finite number`)
  }
  return value
}

/**
 * Validate and default the plugin configuration.
 *
 * Misconfiguration throws here, at load, rather than surfacing as a puzzling
 * tool failure on the first call.
 * @param raw - the loader-supplied config value.
 * @returns the resolved configuration.
 */
export function normalizeConfig(raw) {
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    throw new TypeError('dsh-git-bug: config must be an object')
  }
  const input = raw ?? {}
  const repoPath = input.repoPath === undefined ? process.cwd() : expandPath(String(input.repoPath))
  const apiPath = input.apiPath === undefined ? DEFAULT_API_PATH : String(input.apiPath)
  if (!apiPath.startsWith('/')) throw new TypeError('dsh-git-bug: config.apiPath must start with "/"')
  const identity = {
    name: typeof input.identity?.name === 'string' && input.identity.name.length > 0 ? input.identity.name : DEFAULT_IDENTITY.name,
    email: typeof input.identity?.email === 'string' && input.identity.email.length > 0 ? input.identity.email : DEFAULT_IDENTITY.email,
  }
  const promptOrder = input.promptOrder === undefined ? 120 : Number(input.promptOrder)
  if (!Number.isFinite(promptOrder)) throw new TypeError('dsh-git-bug: config.promptOrder must be a finite number')
  const issueListLimit = input.issueListLimit === undefined ? 25 : Number(input.issueListLimit)
  if (!Number.isInteger(issueListLimit) || issueListLimit <= 0) {
    throw new TypeError('dsh-git-bug: config.issueListLimit must be a positive integer')
  }
  return {
    repoPath,
    remote: input.remote === undefined ? 'origin' : String(input.remote),
    command: input.command === undefined ? 'git-bug' : String(input.command),
    apiPath: apiPath.replace(/\/+$/, ''),
    taskLabel: input.taskLabel === undefined ? DEFAULT_TASK_LABEL : String(input.taskLabel),
    identity,
    autoCreateIdentity: input.autoCreateIdentity === undefined ? true : input.autoCreateIdentity === true,
    promptSection: input.promptSection === undefined ? true : input.promptSection === true,
    promptOrder,
    issueListLimit,
    timeoutMs: positiveNumber(input.timeoutMs, 'timeoutMs', 30_000),
    syncTimeoutMs: positiveNumber(input.syncTimeoutMs, 'syncTimeoutMs', 120_000),
    cacheTtlMs: positiveNumber(input.cacheTtlMs, 'cacheTtlMs', 5000),
  }
}

/**
 * Activate the plugin.
 * @param ctx - plugin context; carries the injected services.
 * @param rawConfig - loader-supplied configuration.
 */
export async function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const run = createSubprocessRunner(ctx.subprocess)
  const availability = createAvailabilityProbe(ctx.subprocess, config.command)
  const repo = createGitBug({
    run,
    repoPath: config.repoPath,
    remote: config.remote,
    timeoutMs: config.timeoutMs,
    syncTimeoutMs: config.syncTimeoutMs,
    availability,
  })
  const board = createBoard({ repo, ttlMs: config.cacheTtlMs })
  // Facts the prompt section needs but cannot compute synchronously: whether the
  // executable exists at all, and whether the automatic identity bootstrap failed.
  const status = { identity: null, unavailable: null }

  // Warm the board so the first prompt assembly already carries the issue list.
  // A read failure is rendered by the prompt section and the panel, so it must
  // not fail plugin activation, and the wait is bounded (see WARMUP_CAP_MS).
  const warmup = board.reload().catch(() => {
    // Rendered as prompt state and reported by the API.
  })
  await Promise.race([warmup, new Promise(resolve => setTimeout(resolve, WARMUP_CAP_MS).unref?.())])

  availability().then((found) => {
    if (found.available !== true) status.unavailable = { available: false, reason: found.reason ?? null }
  }).catch((error) => {
    status.unavailable = { available: false, reason: error instanceof Error ? error.message : String(error) }
  })

  if (config.autoCreateIdentity) {
    repo.ensureIdentity(config.identity).then((result) => {
      status.identity = { ...result, error: null }
      if (result.created) board.invalidate()
    }).catch((error) => {
      status.identity = { error: error instanceof Error ? error.message : String(error) }
    })
  }

  registerTools(ctx, { repo, board, config })

  if (config.promptSection) {
    ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: config.promptOrder,
      text: () => renderPromptSection({
        board,
        config,
        unavailable: status.unavailable,
        identityError: status.identity?.error ?? null,
      }),
    })
  }

  // The panel is optional: a headless profile has no web server, and the tools
  // must still be registered there.
  ctx.inject(['webServer'], (sub) => {
    sub.effect(
      () => sub.webServer.register({
        kind: 'prefix',
        path: config.apiPath,
        handler: createApiHandler({ repo, board, config, availability }),
      }),
      'dsh-git-bug: issues api',
    )
  })
}