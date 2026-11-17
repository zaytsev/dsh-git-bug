/**
 * Model-facing git-bug tools.
 *
 * Every tool is one thin projection of the repository adapter: it validates the
 * few constraints the JSON Schema cannot express, calls one adapter method, and
 * renders a text block. Mutations need no cache to invalidate: the prompt
 * assembly and the GUI panel reflect the change.
 * @module dsh-git-bug/server/tools
 */

import { GitBugFailure, GitBugFailureKind } from '../git-bug.js'
import { formatVocabulary } from '../labels.js'
import { qualifierSummary } from '../query.js'
import { formatIssueDetail, formatIssueList } from '../format.js'

/** Parameter schema shared by every id-taking tool. */
const ID_PARAMETER = {
  type: 'string',
  description: 'Bug id: the full id or the short human id shown in lists (e.g. "c85d1ad").',
  required: true,
}

/**
 * Turn one adapter failure into the message the model reads.
 *
 * The kind is part of the message because it decides what the model should do
 * next: create an identity, drop the id, or stop calling tools in this
 * repository.
 * @param error - the thrown value.
 * @param context - repository facts used by the recovery hints.
 * @returns the model-facing error text.
 */
export function toolErrorText(error, context = {}) {
  const repoPath = context.repoPath ?? 'this workspace'
  if (!(error instanceof GitBugFailure)) {
    return `git-bug failed: ${error instanceof Error ? error.message : String(error)}`
  }
  switch (error.kind) {
    case GitBugFailureKind.UNAVAILABLE:
      return `git-bug is not available: ${error.message}. The plugin needs the \`git-bug\` executable on PATH.`
    case GitBugFailureKind.NOT_A_REPOSITORY:
      return `${repoPath} is not a git repository, so it has no git-bug database: ${error.message}.`
    case GitBugFailureKind.NO_IDENTITY:
      return `This repository has no git-bug identity yet: ${error.message}. Call git_bug_identity with create true, or run \`git-bug user new\` in ${repoPath}.`
    case GitBugFailureKind.NOT_FOUND:
      return `No bug matched that id: ${error.message}. Call git_bug_list and use the id from there.`
    case GitBugFailureKind.TIMEOUT:
      return `git-bug did not finish in time: ${error.message}.`
    case GitBugFailureKind.LOCKED:
      return `Another git-bug process holds this repository: ${error.message}. Wait a moment and retry.`
    case GitBugFailureKind.INVALID_FILTER:
      return `Nothing ran: that filter is not valid for git-bug. ${error.message}`
    default:
      return `git-bug failed: ${error.message}`
  }
}

/**
 * Compile the per-property parameter spec into the raw JSON Schema the tool
 * registry forwards to the provider.
 *
 * `ctx.tools.register` takes a raw JSON Schema root (the MCP bridge shape), so
 * the implicit open object and per-property `required` annotation that
 * `defineTool` accepts have to be spelled out here.
 * @param spec - one property entry per parameter.
 * @returns an open-object JSON Schema with the required names collected.
 */
export function toParameterJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [name, value] of Object.entries(spec)) {
    if (value === null || typeof value !== 'object') {
      throw new TypeError(`dsh-git-bug: parameter "${name}" must be a schema object`)
    }
    const { required: isRequired, ...rest } = value
    if (isRequired === true) required.push(name)
    properties[name] = rest
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

/**
 * Build one registered-tool definition.
 *
 * @param spec - tool identity, schema, presentation, and behavior.
 * @returns a ToolDefinition ready for `ctx.tools.register`.
 */
function defineGitBugTool(spec) {
  const { name, description, parameters, title, kind = 'other', render, execute } = spec
  return {
    name,
    description,
    parameters: toParameterJsonSchema(parameters),
    output: {
      schema: {},
      render,
    },
    presentCall(args) {
      return { card: 'generic', title: typeof title === 'function' ? title(args ?? {}) : title, kind, rawInput: args }
    },
    async execute(args, exec) {
      try {
        return await execute(args ?? {}, exec)
      } catch (error) {
        // The runtime turns a throw into an isError result carrying the message,
        // which is exactly the model-facing channel this needs.
        throw new Error(toolErrorText(error, spec.context ?? {}), { cause: error })
      }
    },
  }
}

/** Render a value as one text content block. */
function textBlock(text) {
  return [{ type: 'text', text }]
}

/**
 * Register the git-bug tool family.
 *
 * @param ctx - plugin context carrying the tool registry.
 * @param deps - repository adapter and resolved configuration.
 * @returns the disposers of the registrations, in registration order.
 */
export function registerTools(ctx, deps) {
  const { repo, config } = deps
  const context = { repoPath: config.repoPath }
  const registered = []

  registered.push(ctx.tools.register(defineGitBugTool({
    name: 'git_bug_list',
    description:
      'List git-bug issues in the current repository, newest edit first. '
      + 'This is the workspace\'s shared task list and the only way to see it: the system prompt does '
      + 'not carry the issue list, so call this before planning multi-step work, and again after a '
      + 'sync to see what other sessions or people changed. '
      + 'Filters: status, labels, literal title terms, a git-bug query, and a result cap.',
    parameters: {
      status: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Only issues in this status. Default open+closed.' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Only issues carrying every one of these labels.' },
      search: {
        type: 'array',
        items: { type: 'string' },
        description: 'Literal terms matched against issue titles. A term containing a colon is matched literally, never parsed.',
      },
      query: {
        type: 'string',
        description: 'git-bug query syntax, for what the parameters above cannot express, e.g. "label:component:ui sort:creation-asc". '
          + `Qualifiers: ${qualifierSummary()}. A query is validated before git-bug runs; quote a term to search it literally.`,
      },
      limit: { type: 'integer', description: 'Maximum issues to return (default 50).' },
      sort: { type: 'string', enum: ['edit', 'creation', 'id'], description: 'Ordering key. Default edit.' },
      direction: { type: 'string', enum: ['asc', 'desc'], description: 'Ordering direction. Default desc.' },
    },
    title: args => `List issues${args.status === undefined || args.status === 'all' ? '' : ` (${String(args.status)})`}`,
    kind: 'search',
    context,
    async execute(args) {
      const status = args.status === 'open' || args.status === 'closed' ? args.status : undefined
      const issues = await repo.list({
        status,
        labels: Array.isArray(args.labels) ? args.labels.map(String) : [],
        titles: Array.isArray(args.search) ? args.search.map(String) : [],
        query: typeof args.query === 'string' ? args.query : '',
        limit: Number.isInteger(args.limit) ? args.limit : 50,
        sort: ['edit', 'creation', 'id'].includes(args.sort) ? args.sort : 'edit',
        direction: args.direction === 'asc' ? 'asc' : 'desc',
      })
      const heading = `git-bug issues in ${config.repoPath}`
      return { issues, heading }
    },
    render(args, value) {
      return textBlock(formatIssueList(value.issues, { heading: value.heading }))
    },
  })))

  registered.push(ctx.tools.register(defineGitBugTool({
    name: 'git_bug_show',
    description:
      'Read one git-bug issue with all of its comments. Use it before editing an issue, '
      + 'before closing it, and when a list row is not enough context.',
    parameters: { id: ID_PARAMETER },
    title: args => `Read issue ${String(args.id ?? '')}`,
    kind: 'read',
    context,
    async execute(args) {
      if (typeof args.id !== 'string' || args.id.trim().length === 0) {
        throw new GitBugFailure('git_bug_show needs a bug id', { kind: GitBugFailureKind.NOT_FOUND })
      }
      return repo.show(args.id.trim())
    },
    render(_args, value) {
      return textBlock(formatIssueDetail(value))
    },
  })))

  registered.push(ctx.tools.register(defineGitBugTool({
    name: 'git_bug_create',
    description:
      'Create a git-bug issue in the current repository. Use it to put a unit of work on the '
      + 'shared, persistent task list before starting it: the title is the task, the message is '
      + 'the plan or acceptance criteria, and labels classify it. '
      + `\`${config.taskLabel}\` marks work an agent owns. Creates are visible to the user `
      + 'immediately in the Issues panel and to other sessions after a push. '
      + `${formatVocabulary(config.labelVocabulary)}`,
    parameters: {
      title: { type: 'string', description: 'One-line task title.', required: true },
      message: { type: 'string', description: 'Body: plan, context, acceptance criteria.' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Labels to attach after creation.' },
    },
    title: args => `Create issue: ${String(args.title ?? '').slice(0, 60)}`,
    kind: 'edit',
    context,
    async execute(args) {
      const created = await repo.create({
        title: typeof args.title === 'string' ? args.title : '',
        message: typeof args.message === 'string' ? args.message : '',
        labels: Array.isArray(args.labels) ? args.labels.map(String) : [],
      })
      return { ...created, title: typeof args.title === 'string' ? args.title : '' }
    },
    render(_args, value) {
      const labels = value.labels.length > 0 ? ` with labels ${value.labels.join(', ')}` : ''
      return textBlock(`created ${value.humanId}${labels}: ${value.title}`)
    },
  })))

  registered.push(ctx.tools.register(defineGitBugTool({
    name: 'git_bug_comment',
    description:
      'Append a comment to a git-bug issue. Use it for progress notes, decisions, findings, and '
      + 'blockers while you work, so the task list stays a real shared record instead of a plan '
      + 'that only exists in this conversation.',
    parameters: {
      id: ID_PARAMETER,
      message: { type: 'string', description: 'Comment body (markdown).', required: true },
    },
    title: args => `Comment on ${String(args.id ?? '')}`,
    kind: 'edit',
    context,
    async execute(args) {
      if (typeof args.id !== 'string' || args.id.trim().length === 0) {
        throw new GitBugFailure('git_bug_comment needs a bug id', { kind: GitBugFailureKind.NOT_FOUND })
      }
      if (typeof args.message !== 'string' || args.message.trim().length === 0) {
        throw new GitBugFailure('git_bug_comment needs a non-empty message', { kind: GitBugFailureKind.COMMAND_FAILED })
      }
      await repo.comment(args.id.trim(), args.message)
      return { id: args.id.trim() }
    },
    render(args) {
      return textBlock(`commented on ${String(args.id ?? '')}`)
    },
  })))

  registered.push(ctx.tools.register(defineGitBugTool({
    name: 'git_bug_status',
    description:
      'Open or close a git-bug issue. Close a task the moment it is actually done, with the '
      + 'evidence in a comment first; reopen it when the work turns out to be incomplete.',
    parameters: {
      id: ID_PARAMETER,
      status: { type: 'string', enum: ['open', 'closed'], description: 'Target status.', required: true },
    },
    title: args => `Set ${String(args.id ?? '')} ${String(args.status ?? '')}`,
    kind: 'edit',
    context,
    async execute(args) {
      if (typeof args.id !== 'string' || args.id.trim().length === 0) {
        throw new GitBugFailure('git_bug_status needs a bug id', { kind: GitBugFailureKind.NOT_FOUND })
      }
      const status = await repo.setStatus(args.id.trim(), args.status)
      return { id: args.id.trim(), status }
    },
    render(_args, value) {
      return textBlock(`${value.id} is now ${value.status}`)
    },
  })))

  registered.push(ctx.tools.register(defineGitBugTool({
    name: 'git_bug_label',
    description:
      'Add or remove one label on a git-bug issue. Labels are the shared vocabulary of the task '
      + `list; use \`${config.taskLabel}\` for work an agent owns, and add one per workstream so the `
      + 'Issues panel stays filterable. '
      + `${formatVocabulary(config.labelVocabulary)}`,
    parameters: {
      id: ID_PARAMETER,
      label: { type: 'string', description: 'Label text.', required: true },
      action: { type: 'string', enum: ['add', 'remove'], description: 'Attach or detach. Default add.' },
    },
    title: args => `${args.action === 'remove' ? 'Remove' : 'Add'} label ${String(args.label ?? '')}`,
    kind: 'edit',
    context,
    async execute(args) {
      if (typeof args.id !== 'string' || args.id.trim().length === 0) {
        throw new GitBugFailure('git_bug_label needs a bug id', { kind: GitBugFailureKind.NOT_FOUND })
      }
      const result = await repo.label(args.id.trim(), args.label, args.action === 'remove' ? 'remove' : 'add')
      return { id: args.id.trim(), ...result }
    },
    render(_args, value) {
      return textBlock(`${value.action === 'remove' ? 'removed' : 'added'} label "${value.label}" on ${value.id}`)
    },
  })))

  registered.push(ctx.tools.register(defineGitBugTool({
    name: 'git_bug_sync',
    description:
      'Synchronize the git-bug database with a git remote: push publishes this repository\'s '
      + 'issues and identities, pull merges the remote\'s. The remote is the shared channel '
      + 'between sessions, machines, and people. Pull before relying on an issue list that '
      + 'someone else may have changed, and push when the user asks to share the task list.',
    parameters: {
      action: { type: 'string', enum: ['push', 'pull'], description: 'Direction of the synchronization.', required: true },
      remote: { type: 'string', description: `Git remote name. Default ${config.remote}.` },
    },
    title: args => `${args.action === 'push' ? 'Push' : 'Pull'} git-bug data`,
    kind: 'fetch',
    context,
    async execute(args) {
      const remote = typeof args.remote === 'string' && args.remote.trim().length > 0 ? args.remote.trim() : undefined
      if (args.action === 'push') {
        const result = await repo.push(remote)
        return result
      }
      if (args.action === 'pull') {
        const result = await repo.pull(remote)
        return result
      }
      throw new GitBugFailure('git_bug_sync needs action "push" or "pull"', { kind: GitBugFailureKind.COMMAND_FAILED })
    },
    render(_args, value) {
      const report = value.report.length > 0 ? `\n${value.report}` : ''
      return textBlock(`${value.direction} ${value.remote} complete${report}`)
    },
  })))

  registered.push(ctx.tools.register(defineGitBugTool({
    name: 'git_bug_identity',
    description:
      'Inspect the git-bug identity this repository writes issues as, or create one when the '
      + 'repository has none. Every write fails without an identity, so this is the first thing '
      + 'to call in a fresh clone.',
    parameters: {
      create: { type: 'boolean', description: 'Create an identity when the repository has none.' },
      name: { type: 'string', description: 'Display name for a created identity.' },
      email: { type: 'string', description: 'Email for a created identity.' },
    },
    title: args => (args.create === true ? 'Ensure git-bug identity' : 'Read git-bug identity'),
    kind: 'edit',
    context,
    async execute(args) {
      if (args.create === true) {
        const result = await repo.ensureIdentity({
          name: typeof args.name === 'string' && args.name.length > 0 ? args.name : config.identity.name,
          email: typeof args.email === 'string' && args.email.length > 0 ? args.email : config.identity.email,
        })
        return result
      }
      const overview = await repo.overview()
      return { identity: overview.identities[0] ?? null, identities: overview.identities }
    },
    render(args, value) {
      if (args.create === true) {
        const identity = value.identity
        return textBlock(`${value.created ? 'created' : 'using existing'} identity ${identity?.name ?? '?'} (${identity?.humanId ?? '?'})`)
      }
      const identity = value.identity
      if (identity === null) {
        return textBlock('this repository has no git-bug identity; call git_bug_identity with create true before writing')
      }
      return textBlock(`identity: ${identity.name} (${identity.humanId})\nid: ${identity.id}`)
    },
  })))

  return registered
}