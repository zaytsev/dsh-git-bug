# AGENTS.md

Instructions for AI agents working in this repository.

## Documentation

`README.md` is for humans evaluating or using the plugin. Keep it short and
feature-focused: what the plugin does, requirements, installation, configuration,
the tools, panel usage, labels, limitations, and development commands.

Do **not** put implementation details, change history, test inventories, API
tables, check evidence, or design rationale in the README. A reader should not
need to know command flags or internal mechanics to use the plugin.

Technical material belongs in the comments of the related git-bug issue:
alternatives considered, decisions and their motivation, failure analysis,
verification details, and follow-ups. Use the issue comments as the durable
engineering record. Find or open the issue before starting work, add progress
and decisions there, and record the final commit hash when the work lands.

If a change makes an existing README statement stale, update it only when it
changes what a user must know. Put the "why" in the issue.

## Source comments

Add a comment only when it really helps a future maintainer understand the code:
a non-obvious constraint, a workaround, an external behavior, or a decision that
could reasonably be undone.

Do not restate the code, narrate history, or label obvious functions and
constants. Prefer clear names and small functions over comments.

Good comment subjects:

- a cache boundary or protocol rule;
- a CLI quirk or subcommand collision;
- a lock, retry, or ordering requirement.

Remove comments such as:

- `/** One issue row in the list. */` above `IssueRow`;
- a comment that repeats the next line;
- "changed X to Y" notes; those belong in the issue and commit.

## Workflow

- Use git-bug as the shared task list: call `git_bug_list` first, create an
  issue before a unit of work, and record decisions there.
- Use conventional commits, one topic per commit. Add the commit hash to the
  issue when the work lands.
- Run `npm run check` before committing. It rebuilds `lib/client.js`; commit
  the regenerated bundle with its source. Never edit `lib/client.js` directly.
- Do not add documentation commentary to `README.md` or this file just to
  narrate a change.

## Development

`nix develop` provides Node, git-bug and the test dependencies.

```sh
npm run check   # build the browser half, then run all tests
npm test        # tests only
npm run build   # browser half only
```
