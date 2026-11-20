/**
 * git-bug adapter: runs the `git-bug` CLI inside one repository and normalizes
 * its output into plain JSON-compatible values.
 *
 * The module owns no process, timer, or filesystem handle. Every command goes
 * through the injected `run`, so the harness executes through
 * `ctx.subprocess` and the test suite executes through `node:child_process`.
 *
 * Verified against git-bug v0.11.0, whose CLI is `git-bug bug …` (v0.7 and
 * earlier used `git-bug ls/new/show`); the command shapes here are that
 * version's.
 * @module dsh-git-bug/git-bug
 */

/** The executable this adapter drives. */
export const GIT_BUG_COMMAND = 'git-bug'

/** Sort keys the list command accepts through --by. */
export const SORT_KEYS = Object.freeze(['id', 'creation', 'edit'])

/** Attempts allowed when another process holds the repository lock. */
const LOCK_ATTEMPTS = 5

/** Base backoff between lock attempts, multiplied by the attempt number. */
const LOCK_BACKOFF_MS = 100

/** Failure classes a caller may branch on. */
export const GitBugFailureKind = Object.freeze({
  /** `git-bug` could not be started at all (missing executable). */
  UNAVAILABLE: 'unavailable',
  /** The directory is not a git repository. */
  NOT_A_REPOSITORY: 'not-a-repository',
  /** The repository has no git-bug identity yet, so writes are refused. */
  NO_IDENTITY: 'no-identity',
  /** The bug id is unknown, ambiguous, or was not supplied. */
  NOT_FOUND: 'not-found',
  /** The command exceeded its deadline. */
  TIMEOUT: 'timeout',
  /** Another git-bug process holds this repository's lock. */
  LOCKED: 'locked',
  /** git-bug refused the filter expression it was given. */
  INVALID_FILTER: 'invalid-filter',
  /** The command failed for any other reason. */
  COMMAND_FAILED: 'command-failed',
})

/**
 * One failed `git-bug` invocation, classified by {@link GitBugFailureKind}.
 * The message is the CLI's own diagnostic, so it stays useful to a human and to
 * the model.
 */
export class GitBugFailure extends Error {
  /**
   * @param message - human-readable diagnostic.
   * @param details - failure classification and command facts.
   */
  constructor(message, details) {
    super(message)
    this.name = 'GitBugFailure'
    this.kind = details.kind
    this.argv = details.argv
    this.code = details.code ?? null
    this.stderr = details.stderr ?? ''
  }
}

/** Exit-code-independent stderr signatures for the CLI's own error classes. */
const DIAGNOSTICS = [
  { kind: GitBugFailureKind.NOT_A_REPOSITORY, pattern: /\.git not found/i },
  { kind: GitBugFailureKind.NO_IDENTITY, pattern: /No identity is set/i },
  { kind: GitBugFailureKind.LOCKED, pattern: /already locked by the process/i },
  { kind: GitBugFailureKind.NOT_FOUND, pattern: /must provide a bug id|no bug found|not found|ambiguous/i },
  { kind: GitBugFailureKind.INVALID_FILTER, pattern: /unknown qualifier|empty qualifier or value/i },
]

/** Classify one failed invocation from its stderr text. */
function classify(stderr) {
  for (const { kind, pattern } of DIAGNOSTICS) {
    if (pattern.test(stderr)) return kind
  }
  return GitBugFailureKind.COMMAND_FAILED
}

/** Read a short stable id from a human id, falling back to the full id head. */
function humanIdOf(raw) {
  if (typeof raw?.human_id === 'string' && raw.human_id.length > 0) return raw.human_id
  return typeof raw?.id === 'string' ? raw.id.slice(0, 7) : ''
}

/**
 * Normalize one git-bug identity object.
 * @param raw - an identity as the CLI serializes it.
 * @returns the identity, or null when the value is not one.
 */
export function identityOf(raw) {
  if (typeof raw !== 'object' || raw === null || typeof raw.id !== 'string') return null
  return {
    id: raw.id,
    humanId: humanIdOf(raw),
    name: typeof raw.name === 'string' ? raw.name : '',
    login: typeof raw.login === 'string' ? raw.login : '',
  }
}

/** Normalize one timestamp object ({ timestamp, time, lamport? }). */
function timeOf(raw) {
  if (typeof raw !== 'object' || raw === null) return null
  const time = typeof raw.time === 'string' ? raw.time : null
  const epoch = typeof raw.timestamp === 'number' ? raw.timestamp : null
  if (time === null && epoch === null) return null
  return { time, epoch }
}

/** Normalize the `labels` array (the CLI serializes "no labels" as null). */
function labelsOf(raw) {
  if (!Array.isArray(raw)) return []
  return raw.filter(label => typeof label === 'string')
}

/**
 * Normalize one bug summary from `git-bug bug --format json`.
 * @param raw - a serialized bug.
 * @returns the summary, or null when the value is not a bug.
 */
export function issueSummaryOf(raw) {
  if (typeof raw !== 'object' || raw === null || typeof raw.id !== 'string') return null
  return {
    id: raw.id,
    humanId: humanIdOf(raw),
    title: typeof raw.title === 'string' ? raw.title : '',
    status: raw.status === 'closed' ? 'closed' : 'open',
    labels: labelsOf(raw.labels),
    createdAt: timeOf(raw.create_time),
    editedAt: timeOf(raw.edit_time),
    author: identityOf(raw.author),
    participants: Array.isArray(raw.participants)
      ? raw.participants.map(identityOf).filter(identity => identity !== null)
      : [],
    comments: typeof raw.comments === 'number' ? raw.comments : 0,
  }
}

/**
 * Normalize one bug detail from `git-bug bug show --format json`.
 * @param raw - a serialized bug with its comment list.
 * @returns the detail, or null when the value is not a bug.
 */
export function issueDetailOf(raw) {
  const summary = issueSummaryOf(raw)
  if (summary === null) return null
  const comments = Array.isArray(raw.comments)
    ? raw.comments
        .filter(comment => typeof comment === 'object' && comment !== null)
        .map(comment => ({
          id: typeof comment.id === 'string' ? comment.id : '',
          humanId: humanIdOf(comment),
          author: identityOf(comment.author),
          message: typeof comment.message === 'string' ? comment.message : '',
          createdAt: timeOf(comment.create_time),
        }))
    : []
  return { ...summary, comments, commentCount: comments.length }
}

/** Parse a JSON document, reporting the command that produced unusable output. */
function parseJson(argv, stdout) {
  try {
    return JSON.parse(stdout)
  } catch {
    throw new GitBugFailure(`git-bug returned output that is not JSON for "${argv.join(' ')}"`, {
      kind: GitBugFailureKind.COMMAND_FAILED,
      argv,
      stderr: stdout.slice(0, 400),
    })
  }
}

/** Remove a leading "Error: " so the message reads as a sentence. */
function diagnosticOf(text, fallback) {
  const line = text.split('\n').map(part => part.trim()).find(part => part.length > 0)
  if (line === undefined) return fallback
  return line.replace(/^Error:\s*/i, '')
}

/**
 * Split free-form filter text into the positional terms git-bug's parser expects.
 *
 * git-bug reads one query term per argument, so `label:ui status:open` has to
 * arrive as two arguments, never one. Quotes group words into a single term the
 * way a shell would, so `title:"Render issue"` reaches the CLI as
 * `title:Render issue`. Nothing here knows what a qualifier means: that is
 * git-bug's job, and its diagnostics are passed through unchanged.
 * @param text - the filter text, possibly empty.
 * @returns one argument per term, in order.
 */
function splitQuery(text) {
  const terms = []
  let current = ''
  let quote = null
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current.length > 0) terms.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.length > 0) terms.push(current)
  return terms
}

/**
 * Create the adapter for one repository.
 *
 * @param options - execution and repository facts.
 * @param options.run - executes one argv; resolves with exit facts, never throws for a non-zero exit.
 * @param options.repoPath - absolute path of the git repository the adapter reads and writes.
 * @param options.remote - git remote name used by push and pull.
 * @param options.timeoutMs - deadline for local commands.
 * @param options.syncTimeoutMs - deadline for push and pull, which talk to a remote.
 * @param options.availability - probes availability once; cached by the caller.
 * @returns the repository-scoped adapter.
 */
export function createGitBug(options) {
  const { run, repoPath, remote = 'origin', timeoutMs = 30_000, syncTimeoutMs = 120_000, availability } = options

  // git-bug takes an exclusive per-repository lock, so two of its processes in
  // one repository fail with "already locked". Every command therefore runs one
  // at a time through this queue, whatever the caller does concurrently.
  let queue = Promise.resolve()

  /**
   * Run one task after every previously queued task settled.
   * @param task - the work to run.
   * @returns the task's own result or failure.
   */
  function enqueue(task) {
    const next = queue.then(task, task)
    queue = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * Execute one git-bug command in the repository.
   * @param args - arguments after the executable name.
   * @param exec - optional stdin payload and deadline override.
   * @returns the child's collected stdout.
   */
  async function exec(args, exec = {}) {
    return enqueue(() => runOnce(args, exec))
  }

  /**
   * Execute one command and map its exit facts onto a classified failure.
   * @param args - arguments after the executable name.
   * @param exec - optional stdin payload and deadline override.
   * @returns the child's collected stdout.
   */
  async function runOnce(args, exec = {}) {
    const argv = [GIT_BUG_COMMAND, ...args]
    const deadline = exec.timeoutMs ?? timeoutMs
    for (let attempt = 1; ; attempt += 1) {
      const result = await run({ argv, cwd: repoPath, input: exec.input, timeoutMs: deadline, signal: exec.signal })
      const stderr = typeof result.stderr === 'string' ? result.stderr : ''
      if (result.timedOut === true) {
        throw new GitBugFailure(`git-bug ${args[0] ?? ''} did not finish within ${String(deadline)}ms`, {
          kind: GitBugFailureKind.TIMEOUT,
          argv,
          code: result.code,
          stderr,
        })
      }
      if (result.code !== 0) {
        const kind = classify(stderr)
        // A lock held by a short-lived outside process clears on its own; one
        // held by a concurrent call in this plugin cannot, because this queue
        // serializes those. Back off a bounded number of times, then report.
        if (kind === GitBugFailureKind.LOCKED && attempt < LOCK_ATTEMPTS) {
          await new Promise(resolve => setTimeout(resolve, LOCK_BACKOFF_MS * attempt))
          continue
        }
        const message = diagnosticOf(stderr, `git-bug ${args[0] ?? ''} failed with exit code ${String(result.code)}`)
        throw new GitBugFailure(message, { kind, argv, code: result.code, stderr })
      }
      return { stdout: typeof result.stdout === 'string' ? result.stdout : '', stderr }
    }
  }

  /** Run a command and parse its JSON stdout. */
  async function execJson(args, options) {
    const { stdout } = await exec(args, options)
    return parseJson([GIT_BUG_COMMAND, ...args], stdout)
  }

  return {
    /** Absolute repository path every command runs in. */
    repoPath,
    /** git remote name used by {@link push} and {@link pull}. */
    remote,

    /**
     * List the labels this repository actually uses.
     *
     * git-bug has no label policy and no JSON output here: `git-bug label`
     * prints the labels in use, one per line. A failure is reported as "no
     * labels" rather than failing the overview it feeds.
     * @returns the labels in use, sorted.
     */
    async labels() {
      try {
        const { stdout } = await exec(['label'])
        return [...new Set(stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0))].sort()
      } catch {
        return []
      }
    },

    /**
     * Read the repository's identity, bug count, labels in use, and remotes in one pass.
     * @returns the repository overview.
     */
    async overview() {
      const [identityList, issues, labels] = await Promise.all([
        execJson(['user', '--format', 'json']),
        execJson(['bug', '--format', 'json']),
        this.labels(),
      ])
      const identities = Array.isArray(identityList) ? identityList.map(identityOf).filter(i => i !== null) : []
      const summaries = Array.isArray(issues) ? issues.map(issueSummaryOf).filter(issue => issue !== null) : []
      return {
        repoPath,
        remote,
        identities,
        labels,
        issues: summaries,
        counts: {
          open: summaries.filter(issue => issue.status === 'open').length,
          closed: summaries.filter(issue => issue.status === 'closed').length,
          total: summaries.length,
        },
      }
    },

    /**
     * List bugs, optionally filtered.
     *
     * The structured parameters (status, labels, literal title terms, ordering)
     * become git-bug flags. Free-form filter text becomes positional arguments
     * for git-bug's own query parser, so the plugin never re-implements the
     * dialect and never second-guesses the CLI's diagnostics.
     * @param query - structured filters, free-form query text, and a result cap.
     * @returns matching bug summaries, newest edit first when no order is given.
     */
    async list(query = {}) {
      const args = ['bug', '--format', 'json']
      const status = query.status === 'open' || query.status === 'closed' ? query.status : null
      if (status !== null) args.push('--status', status)
      for (const label of query.labels ?? []) args.push('--label', String(label))
      for (const title of query.titles ?? []) args.push('--title', String(title))
      args.push('--by', query.sort ?? 'edit', '--direction', query.direction ?? 'desc')
      // The filter box is git-bug's query language; the CLI owns it. The
      // separator keeps a bare term that happens to equal a subcommand (`label`,
      // `show`, `status`, ...) from being dispatched as that command before the
      // query parser sees it.
      const terms = splitQuery(typeof query.query === 'string' ? query.query : '')
      if (terms.length > 0) {
        args.push('--')
        for (const term of terms) args.push(term)
      }
      const raw = await execJson(args)
      const issues = (Array.isArray(raw) ? raw : []).map(issueSummaryOf).filter(issue => issue !== null)
      const limit = query.limit ?? issues.length
      return issues.slice(0, Math.max(0, limit))
    },

    /**
     * Read one bug with its comments.
     * @param id - full bug id or an unambiguous human id.
     * @returns the bug detail.
     */
    async show(id) {
      const raw = await execJson(['bug', 'show', String(id), '--format', 'json'])
      const detail = issueDetailOf(raw)
      if (detail === null) {
        throw new GitBugFailure(`git-bug did not return a bug for "${String(id)}"`, {
          kind: GitBugFailureKind.NOT_FOUND,
          argv: [GIT_BUG_COMMAND, 'bug', 'show', String(id)],
        })
      }
      return detail
    },

    /**
     * Create a bug.
     *
     * Long bodies travel on stdin (`-F -`) with the title as the first line;
     * short ones use `-t`/`-m`. The CLI derives the title from the first stdin
     * line when both are supplied, so only one of the two forms is ever used.
     * @param input - title, message, and labels to attach after creation.
     * @returns the created bug's human id.
     */
    async create(input) {
      const title = String(input.title ?? '').trim()
      if (title.length === 0) throw new GitBugFailure('a bug needs a non-empty title', { kind: GitBugFailureKind.COMMAND_FAILED, argv: [GIT_BUG_COMMAND] })
      if (title.includes('\n')) throw new GitBugFailure('a bug title must be a single line', { kind: GitBugFailureKind.COMMAND_FAILED, argv: [GIT_BUG_COMMAND] })
      const message = typeof input.message === 'string' ? input.message : ''
      const large = message.length > 60_000
      const args = ['bug', 'new', '--non-interactive']
      if (large) args.push('--file', '-')
      else {
        args.push('--title', title)
        if (message.length > 0) args.push('--message', message)
      }
      const { stdout } = await exec(args, large ? { input: `${title}\n\n${message}` } : {})
      const created = stdout.trim().split(/\s+/)[0] ?? ''
      for (const label of input.labels ?? []) await exec(['bug', 'label', 'new', created, label])
      return { humanId: created, labels: [...(input.labels ?? [])] }
    },

    /**
     * Append a comment to a bug.
     * @param id - bug id.
     * @param message - comment body.
     * @returns nothing; the CLI prints no id.
     */
    async comment(id, message) {
      const body = String(message ?? '')
      if (body.trim().length === 0) throw new GitBugFailure('a comment needs a non-empty message', { kind: GitBugFailureKind.COMMAND_FAILED, argv: [GIT_BUG_COMMAND] })
      if (body.length > 60_000) await exec(['bug', 'comment', 'new', String(id), '--file', '-', '--non-interactive'], { input: body })
      else await exec(['bug', 'comment', 'new', String(id), '--message', body, '--non-interactive'])
    },

    /**
     * Open or close a bug.
     * @param id - bug id.
     * @param status - the target status.
     * @returns the status that was applied.
     */
    async setStatus(id, status) {
      const next = status === 'closed' ? 'closed' : status === 'open' ? 'open' : null
      if (next === null) throw new GitBugFailure(`unknown status "${String(status)}"; expected open or closed`, { kind: GitBugFailureKind.COMMAND_FAILED, argv: [GIT_BUG_COMMAND] })
      await exec(['bug', 'status', next === 'closed' ? 'close' : 'open', String(id)])
      return next
    },

    /**
     * Add or remove one label.
     * @param id - bug id.
     * @param label - label text.
     * @param action - whether to add or remove.
     * @returns the label and the action applied.
     */
    async label(id, label, action = 'add') {
      const value = String(label ?? '').trim()
      if (value.length === 0) throw new GitBugFailure('a label needs a non-empty value', { kind: GitBugFailureKind.COMMAND_FAILED, argv: [GIT_BUG_COMMAND] })
      await exec(['bug', 'label', action === 'remove' ? 'rm' : 'new', String(id), value])
      return { label: value, action: action === 'remove' ? 'remove' : 'add' }
    },

    /**
     * Push bug data to the git remote.
     * @param target - remote name; defaults to the configured one.
     * @returns the CLI's own report and the remote used.
     */
    async push(target) {
      const name = target ?? remote
      const { stdout, stderr } = await exec(['push', name], { timeoutMs: syncTimeoutMs })
      return { remote: name, direction: 'push', report: (stdout + stderr).trim() }
    },

    /**
     * Pull bug data from the git remote.
     * @param target - remote name; defaults to the configured one.
     * @returns the CLI's own report and the remote used.
     */
    async pull(target) {
      const name = target ?? remote
      const { stdout, stderr } = await exec(['pull', name], { timeoutMs: syncTimeoutMs })
      return { remote: name, direction: 'pull', report: (stdout + stderr).trim() }
    },

    /**
     * Create an identity when the repository has none.
     *
     * A repository without an identity still reads fine but refuses every
     * write, so the plugin bootstraps one before it advertises writes.
     * @param fallback - name and email used when the repository has no identity.
     * @returns the identity now in effect, and whether this call created it.
     */
    async ensureIdentity(fallback) {
      const listed = await execJson(['user', '--format', 'json'])
      const existing = Array.isArray(listed) ? listed.map(identityOf).filter(identity => identity !== null) : []
      if (existing.length > 0) return { identity: existing[0], created: false }
      const name = fallback?.name ?? 'DeepSeek Harness'
      const email = fallback?.email ?? 'harness@localhost'
      const { stdout } = await exec(['user', 'new', '--name', name, '--email', email, '--avatar', '', '--non-interactive'])
      const id = stdout.trim()
      return { identity: { id, humanId: id.slice(0, 7), name, login: '' }, created: true }
    },

    /**
     * Report whether git-bug is usable here, without throwing.
     * @returns availability, version, repository status, and identity.
     */
    async probe() {
      const found = availability === undefined ? { available: true } : await availability()
      if (!found.available) return { ...found, repository: false, identity: null, counted: 0 }
      try {
        const overview = await this.overview()
        return {
          available: true,
          version: found.version ?? null,
          executable: found.executable ?? null,
          repository: true,
          identity: overview.identities[0] ?? null,
          counted: overview.counts.total,
          counts: overview.counts,
        }
      } catch (error) {
        if (error instanceof GitBugFailure) {
          return {
            available: true,
            version: found.version ?? null,
            executable: found.executable ?? null,
            repository: error.kind !== GitBugFailureKind.NOT_A_REPOSITORY,
            identity: null,
            counted: 0,
            error: { kind: error.kind, message: error.message },
          }
        }
        throw error
      }
    },
  }
}
