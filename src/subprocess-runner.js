/**
 * Subprocess execution for the git-bug adapter, routed through the harness
 * subprocess capability (`ctx.subprocess`).
 *
 * The capability owns process trees, escalation, and output collection; this
 * module only maps its handles onto the adapter's `{ stdout, stderr, code,
 * timedOut }` outcome.
 * @module dsh-git-bug/subprocess-runner
 */

/** In-memory cap for one collected stream; git-bug JSON payloads are small. */
const STDOUT_CAP_BYTES = 8 * 1024 * 1024

/** In-memory cap for diagnostics. */
const STDERR_CAP_BYTES = 256 * 1024

/** Grace period between SIGTERM and SIGKILL when a command must be stopped. */
const GRACE_MS = 2000

/**
 * Build the runner the adapter executes through.
 * @param subprocess - the harness subprocess service.
 * @returns a function that executes one argv in one directory.
 */
export function createSubprocessRunner(subprocess) {
  /**
   * Execute one command.
   * @param request - argv, working directory, optional stdin payload, and deadline.
   * @returns exit code, collected stdout/stderr, and whether the deadline fired.
   */
  return async function run(request) {
    const { argv, cwd, input, timeoutMs } = request
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, timeoutMs)
    timer.unref?.()
    let handle
    try {
      handle = subprocess.spawn({
        argv,
        cwd,
        stdio: {
          stdin: input === undefined ? 'ignore' : { data: input },
          stdout: { maxBytes: STDOUT_CAP_BYTES },
          stderr: { maxBytes: STDERR_CAP_BYTES },
        },
        graceMs: GRACE_MS,
        signal: controller.signal,
        // A credential prompt would hang a non-interactive session; fail instead.
        env: { GIT_TERMINAL_PROMPT: '0' },
      })
    } catch (error) {
      return {
        code: 127,
        stdout: '',
        stderr: `could not start ${argv[0]}: ${error instanceof Error ? error.message : String(error)}`,
        timedOut: false,
      }
    }
    try {
      const outcome = await handle.done
      const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
      const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
      return { code: outcome.exitCode, stdout, stderr, timedOut: controller.signal.aborted }
    } catch (error) {
      return {
        code: 127,
        stdout: '',
        stderr: `could not start ${argv[0]}: ${error instanceof Error ? error.message : String(error)}`,
        timedOut: false,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Probe the execution world for the git-bug executable.
 * @param subprocess - the harness subprocess service.
 * @param command - executable name or absolute path to resolve.
 * @returns availability plus the resolved path and reported version.
 */
export function createAvailabilityProbe(subprocess, command = 'git-bug') {
  let pending
  /**
   * Resolve availability once per plugin activation.
   * @returns whether git-bug can be executed, its path, and its version line.
   */
  return async function availability() {
    pending ??= (async () => {
      let executable
      try {
        executable = await subprocess.resolveExecutable(command)
      } catch (error) {
        return {
          available: false,
          executable: null,
          version: null,
          reason: `${command} was not found on PATH: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      try {
        const handle = subprocess.spawn({
          argv: [executable, 'version'],
          cwd: process.cwd(),
          stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
          graceMs: GRACE_MS,
        })
        const outcome = await handle.done
        const version = (handle.collected.stdout?.readFrom(0).text ?? '').trim().split('\n')[0] ?? null
        if (outcome.exitCode !== 0) {
          return { available: false, executable, version: null, reason: `${command} version failed with exit code ${String(outcome.exitCode)}` }
        }
        return { available: true, executable, version }
      } catch (error) {
        return { available: false, executable, version: null, reason: error instanceof Error ? error.message : String(error) }
      }
    })()
    return pending
  }
}
