/**
 * Test support: throwaway git repositories, a real git-bug runner over
 * `node:child_process`, and a Cordis-shaped fake context.
 *
 * Tests exercise the real executable: the adapter's contract is the CLI's
 * behavior, so a mock would test the mock.
 * @module dsh-git-bug/tests/support
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGitBug } from '../src/git-bug.js'

/** Isolated HOME so git and git-bug never read the developer's own config. */
export const TEST_HOME = mkdtempSync(join(tmpdir(), 'dsh-git-bug-home-'))

/** Credential-free, non-interactive child environment for every test command. */
export const TEST_ENV = {
  ...process.env,
  HOME: TEST_HOME,
  XDG_CONFIG_HOME: join(TEST_HOME, '.config'),
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_GLOBAL: join(TEST_HOME, '.gitconfig'),
  GIT_CONFIG_SYSTEM: join(TEST_HOME, '.gitconfig'),
  EMAIL: 'agent@example.com',
  GIT_AUTHOR_NAME: 'Agent',
  GIT_AUTHOR_EMAIL: 'agent@example.com',
  GIT_COMMITTER_NAME: 'Agent',
  GIT_COMMITTER_EMAIL: 'agent@example.com',
}

/**
 * Execute one argv in one directory, collecting bounded output.
 * @param request - argv, cwd, optional stdin payload, and deadline.
 * @returns exit code, collected stdout/stderr, and whether the deadline fired.
 */
export function childProcessRunner(request) {
  const { argv, cwd, input, timeoutMs = 30_000 } = request
  return new Promise((resolvePromise) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: TEST_ENV, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ code: 127, stdout, stderr: stderr + String(error.message), timedOut: false })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr, timedOut })
    })
    if (input === undefined) child.stdin.end()
    else child.stdin.end(input)
  })
}

/**
 * Run git in one directory and require success.
 * @param cwd - repository directory.
 * @param args - git arguments.
 * @returns the command's stdout.
 */
export async function git(cwd, args) {
  const result = await childProcessRunner({ argv: ['git', ...args], cwd })
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

/**
 * Create a git repository with one commit and (optionally) a git-bug identity.
 * @param options - identity creation and root directory.
 * @returns the repository path.
 */
export async function makeRepo(options = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'dsh-git-bug-repo-'))
  mkdirSync(root, { recursive: true })
  await git(root, ['init', '-q', '-b', 'main', '.'])
  writeFileSync(join(root, 'README.md'), '# test repository\n')
  await git(root, ['add', '.'])
  await git(root, ['commit', '-qm', 'init'])
  if (options.identity !== false) {
    const result = await childProcessRunner({
      argv: ['git-bug', 'user', 'new', '--name', 'Agent', '--email', 'agent@example.com', '--avatar', '', '--non-interactive'],
      cwd: root,
    })
    if (result.code !== 0) throw new Error(`git-bug user new failed: ${result.stderr}`)
  }
  return root
}

/**
 * Create the adapter for one test repository.
 * @param repoPath - repository path.
 * @param overrides - adapter options to override.
 * @returns the repository adapter.
 */
export function adapter(repoPath, overrides = {}) {
  return createGitBug({ run: childProcessRunner, repoPath, timeoutMs: 60_000, ...overrides })
}

/**
 * Create a Cordis-shaped context that records what the plugin registers.
 * @param options - subprocess service and web-server presence.
 * @returns the fake context plus the recorded registrations.
 */
export function fakeContext(options = {}) {
  const tools = []
  const sections = []
  const routes = []
  const disposers = []
  const webServer = {
    /**
     * Record one route registration.
     * @param route - the route the plugin mounts.
     * @returns the unregister disposer.
     */
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
  const subprocess = options.subprocess ?? {
    /** Resolve a bare executable name through PATH. */
    async resolveExecutable(command) { return command },
    /** Spawn through node:child_process. */
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...TEST_ENV, ...spec.env } })
      let stdoutText = ''
      let stderrText = ''
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdoutText += chunk })
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderrText += chunk })
      if (spec.stdio?.stdin?.data !== undefined) child.stdin.end(spec.stdio.stdin.data)
      else child.stdin.end()
      return {
        pid: child.pid ?? -1,
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        collected: {
          stdout: { readFrom: () => ({ text: stdoutText, nextOffset: stdoutText.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderrText, nextOffset: stderrText.length, lossy: false }) },
        },
        done: new Promise((resolve, reject) => {
          child.on('error', reject)
          child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
        }),
        terminate() { child.kill('SIGKILL') },
        async waitForExit() { return true },
      }
    },
  }
  const ctx = {
    subprocess,
    tools: {
      /**
       * Record one tool registration.
       * @param definition - the tool definition.
       * @returns the unregister disposer.
       */
      register(definition) {
        tools.push(definition)
        const dispose = () => {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
        }
        disposers.push(dispose)
        return dispose
      },
    },
    systemPrompt: {
      /**
       * Record one prompt section.
       * @param section - the section registration.
       * @returns the unregister disposer.
       */
      section(section) {
        sections.push(section)
        const dispose = () => {
          const index = sections.indexOf(section)
          if (index >= 0) sections.splice(index, 1)
        }
        disposers.push(dispose)
        return dispose
      },
    },
    /**
     * Mount a child context with the requested services, as Cordis does.
     * @param names - service names the callback needs.
     * @param callback - the plugin body.
     */
    inject(names, callback) {
      if (options.webServer === false) return
      const child = Object.create(ctx)
      if (names.includes('webServer')) child.webServer = webServer
      callback(child)
    },
    /**
     * Track one effect.
     * @param fn - effect body.
     * @param label - effect label.
     * @returns the disposer.
     */
    effect(fn, label) {
      const dispose = fn()
      const tracked = () => {
        if (typeof dispose === 'function') dispose()
      }
      disposers.push(tracked)
      void label
      return tracked
    },
    logger: { warn() {}, error() {}, info() {} },
  }
  return { ctx, tools, sections, routes, disposers, webServer }
}
