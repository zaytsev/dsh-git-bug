# dsh-git-bug

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that turns
[git-bug](https://github.com/git-bug/git-bug) issues in the current workspace into the agent's
shared, persistent task list — and into an **Issues** panel in the web client.

git-bug stores issues in git refs, so they are versioned, offline-first, and travel with the same
remote the repository already uses. This plugin makes them a first-class surface for the agent and
for the user:

| Surface | What it does |
|---|---|
| **Agent tools** | Eight `git_bug_*` tools let the model list, read, create, comment on, label, close, and sync issues. |
| **System prompt** | A prompt section states how and *when* to use them. It is byte-stable: the live issue list is fetched with `git_bug_list`, never injected into the prompt (see below). |
| **Web panel** | A sidebar **Issues** entry opens a panel that lists, filters, reads, creates, comments on, closes, labels, and pushes/pulls issues. |

The plugin assumes the `git-bug` executable is installed (v0.11.0 or newer — that release renamed
the CLI to `git-bug bug …`) and that the workspace is a git repository.

## Requirements

- `git-bug` ≥ 0.11.0 on `PATH` (`git-bug version`)
- `git` and a git repository as the harness working directory
- DeepSeek Harness `>=0.2.2-0 <0.3.0` (matches `engines.dsh`)

A repository without a git-bug identity still reads fine; the plugin creates an identity on
activation (`autoCreateIdentity`, default on) so that writes work, and reports the fact in the
prompt and the panel.

## Install

### With Nix (recommended here)

```sh
nix develop                # node, git, git-bug, jq — the plugin's build and test inputs
nix build .#plugin         # the installable plugin tree
nix run .#install          # links it into ${DSH_HOME:-~/.config/dsh}/node_modules/dsh-git-bug
```

Once this directory is a git repository, Nix only sees **tracked** files: with the tree untracked,
`nix develop` fails with "is not tracked by Git" and `nix build` would ship an empty package. Run
`git add -A` (and commit) first, or the flake will not see the package sources.

### With the deepseek-harness Home Manager module

The overlay publishes the plugin in the shape that module's `settings.plugins` consumes — the same
shape `pkgs/deepseek/plugins/dsh-utils.nix` builds: an entry carrying `id`, `entry`, `client`,
`packageName`, `packageDir` and `config`, callable with a config through `__functor`.

```nix
{
  inputs.dsh-git-bug.url = "github:you/dsh-git-bug";

  # wherever your nixpkgs is instantiated
  nixpkgs.overlays = [ inputs.dsh-git-bug.overlays.default ];
}
```

```nix
programs.deepseek-harness = {
  enable = true;
  settings.plugins = [
    # bare, with the plugin's defaults:
    pkgs.dshPlugins.dsh-git-bug
    # …or bind the row config (any subset of the table above) instead:
    # (pkgs.dshPlugins.dsh-git-bug {repoPath = "/home/me/projects/thing";})
  ];
};
```

The module then generates the loader row (`{id = "dsh-git-bug"; name = "dsh-git-bug"; config = …;}`)
into the `--patch` layer it passes to the launcher, and links `packageDir` into
`$DSH_HOME/node_modules/dsh-git-bug` — the anchor both the loader import and the host's
client-module scan resolve the row name through. Nothing is written into `$DSH_HOME` for this plugin
beyond that link.

Why the entry looks like that, if you are comparing it with `dsh-utils.nix`:

| field | value here | why |
|---|---|---|
| `id` | `dsh-git-bug` | row id; also the id a disable patch targets |
| `client` | `true` | the package declares `dsh.client`, so the module names the row after the **package**, not the generated entry. An absolute entry path makes the browser half invisible to the host's client-module scan |
| `entry` | `<staged>/entry.mjs` | a three-line re-export of the package by name, sitting beside a `node_modules` tree so that import resolves |
| `packageDir` | `<staged>/node_modules/dsh-git-bug` | what the module links into `$DSH_HOME/node_modules` |
| `config` | `{}` | defaults; merge your own with `(pkgs.dshPlugins.dsh-git-bug { repoPath = …; })` |
| `patch` | `null` | not a bundle: the module generates the row instead of mounting a layer |

`packages.<system>.plugin` stays the plain package tree, which is what `nix run .#install` symlinks.
The module-shaped entry exists only through the overlay: a custom top-level flake output would make
`nix flake check` warn about an unknown output.

### With any package manager

The plugin is a plain ESM package with no runtime dependencies. It only has to be resolvable by
package name from the profile, which is the same place `dsh plugin add` puts things:

```sh
ln -s "$PWD" "${DSH_HOME:-$HOME/.config/dsh}/node_modules/dsh-git-bug"
```

### Mount the row

The package ships `cordis.patch.yml`, which inserts the loader row:

```yaml
- insert:
    - id: dsh-git-bug
      name: dsh-git-bug
```

Launch the web profile with it:

```sh
dsh --profile web --patch "$PWD/cordis.patch.yml"
```

For a permanent mount, add the same row under `insert:` in
`${DSH_HOME:-~/.config/dsh}/cordis.patch.yml` (the home-level patch layer applies to every
profile).

Run `dsh` through its installed launcher rather than a hand-rolled `node …/bin.js` invocation: the
launcher passes `--expose-internals`, which is what lets the loader resolve out-of-tree rows by
package name.

## Configuration

Config is read from the row, e.g.:

```yaml
- id: dsh-git-bug
  config:
    repoPath: /home/me/projects/thing
    remote: origin
    taskLabel: agent-task
```

| Field | Default | Meaning |
|---|---|---|
| `repoPath` | `process.cwd()` | Repository the plugin reads and writes. `~/` expands. One repository per plugin instance. |
| `remote` | `origin` | Git remote used by `git_bug_sync` and the panel's pull/push buttons. |
| `apiPath` | `/git-bug/v1` | Mount point of the panel's JSON API on the harness web server. |
| `taskLabel` | `ai` | Label the prompt tells the agent to put on work it owns. |
| `labelVocabulary` | the table below | Replace any group of suggested labels (`kinds`, `priorities`, `severities`, `states`, `ownership`, `componentPrefix`). |
| `identity` | `{ name: 'DeepSeek Harness', email: 'harness@localhost' }` | Identity created in repositories that have none. |
| `autoCreateIdentity` | `true` | Create that identity at activation instead of failing the first write. |
| `promptSection` | `true` | Contribute the system-prompt section. |
| `promptOrder` | `120` | Section order (tool guidance lives at 100–199). |
| `sessionCue` | `true` | Inject the task-list cue (with live counts when they are already read) at `agent/session-start`. |
| `todoNudge` | `true` | Inject one reminder per session, the first time that session calls `todo_write`. |
| `timeoutMs` | `30000` | Deadline for local git-bug commands. |
| `syncTimeoutMs` | `120000` | Deadline for push/pull. |

Invalid configuration throws at load, not on the first tool call.

## The tools

| Tool | Arguments | Purpose |
|---|---|---|
| `git_bug_list` | `status`, `labels[]`, `search[]`, `query`, `limit`, `sort`, `direction` | Read the shared list; the first thing to do before planning. |
| `git_bug_show` | `id` | One issue with all comments. |
| `git_bug_create` | `title`, `message`, `labels[]` | Put a unit of work on the list before starting it. |
| `git_bug_comment` | `id`, `message` | Progress, decisions, blockers. |
| `git_bug_status` | `id`, `status` (`open`/`closed`) | Close when genuinely done; reopen otherwise. |
| `git_bug_label` | `id`, `label`, `action` | Shared vocabulary for filtering. |
| `git_bug_sync` | `action` (`push`/`pull`), `remote` | Publish or merge with the git remote. |
| `git_bug_identity` | `create`, `name`, `email` | Inspect or create the write identity. |

Ids may be full or the short human id shown in lists (`0f43de6`). Failures are classified, so the
model reads what to do next: not a repository, no identity, no such bug, another process holding the
repository lock, or a timeout.

### Filters

`git_bug_list` has two filter modes, and they never mix:

- **Structured parameters** — `status`, `labels[]`, `search[]` — map onto git-bug's own flags.
  A `search` term is matched against issue titles literally, so `component:ui` stays a term.
- **`query`** takes git-bug's query language (`status:open sort:creation-asc`) for what the
  parameters cannot express. `src/query.js` parses and validates it before any process starts, so a
  malformed qualifier is answered with the accepted vocabulary (`status: label: author: actor:
  participant: title: metadata: no: sort:`) rather than with the CLI's `Error: empty qualifier or
  value`. Quoting a term makes it literal.

The split exists because positional arguments *are* query syntax to `git-bug bug`: a half-typed
qualifier is a parse error and a legitimate label is an "unknown qualifier". The panel's search box
therefore only ever sends `search` terms, and its label filters are a picker over the vocabulary.

## How the agent is made aware, without touching the cache

The prompt section is a **pure function of the configuration**: instructions, the repository path,
the remote name, and the task label. It carries no counts, no identity, no issue list, and no
availability probe result.

That is a cache contract, not a style choice. Providers match a request against their cached prefix
byte-for-byte, so state rendered into the system prompt rewrites it in place — invalidating the
cached prefix of that request *and every request after it*, including the whole conversation
history. Rendering volatile state last does not help: what follows the change is the history.

The section carries two rules, and both are written to be checkable rather than aspirational: the
first tool call in any task that takes more than one step is `git_bug_list`; `todo_write` is a
private step list inside a single turn, and anything that must outlive the turn, be visible in the
panel, or be shared goes to git-bug instead.

Live state therefore reaches the model the cache-safe way — through the tools, whose results append
at the tail of the conversation:

Two injected cues close the gap the static prompt leaves:

- **At `agent/session-start`** the plugin injects one user-role message with the rule and, when the
  repository has already been read, the live counts ("3 open · 1 labelled agent-task"). Injection is
  synchronous — the first step claims its messages immediately — so a cold start falls back to the
  rule without numbers and the read that fills them runs in the background for the next session.
- **On the first `todo_write` of a session** it injects one reminder that points at git-bug. Asked
  once per session, after the tool result, with the decision passed through untouched.

Both append at the tail, so neither can move the cached prefix; both are switchable (`sessionCue`,
`todoNudge`) for deployments that want the prompt alone.

- `git_bug_list` is how the model sees the task list, and the section says so;
- a turn that creates, comments on, or closes issues leaves the cached prefix intact, because the
  prompt never changed;
- the section is registered as a literal string, so it cannot vary between assemblies at all.

`tests/harness.test.mjs` enforces this end to end: it boots the real harness against a stub
provider, drives a turn whose plan writes to git-bug, and asserts every step of the turn carried a
**byte-identical** system prompt.

## Labels

A starting vocabulary, so an agent and a human reach for the same words instead of inventing
one-offs. It is **not** a policy: nothing validates against it, any label is accepted everywhere, and
a repository can replace any group through `labelVocabulary`.

| Group | Labels | Intended use |
|---|---|---|
| kind | `bug` `feature` `enhancement` `refactor` `docs` `todo` | what the issue is; pick one |
| priority | `priority:low` `priority:normal` `priority:high` `priority:urgent` | how soon |
| severity | `severity:minor` `severity:major` `severity:critical` `severity:blocker` | how bad; bugs only |
| state | `blocked` `needs-info` `duplicate` `wontfix` `cant-reproduce` | why an issue is not simply open |
| ownership | `ai` | work an agent owns |
| component | `component:<area>` — e.g. `component:panel`, `component:nix` | which part of the codebase |

One source feeds all four surfaces: the system-prompt rule, the `git_bug_create` / `git_bug_label`
descriptions, the panel's chips and label autocomplete (served from `/overview`), and this table.
`component:` is the only open prefix — everything else is a closed group.

## The panel

A sidebar footer action (`sidebar.footer.action`) opens a full-screen overlay (`shell.overlay`)
rendered by the browser half. It talks to the server half over the plugin's own JSON API — no RPC
plumbing, no session needed — and shows repository truth: the same list the agent reads.

| Endpoint | Method | Purpose |
|---|---|---|
| `/git-bug/v1/overview` | GET | Repository, identity, counts, issues, availability. |
| `/git-bug/v1/issues` | GET / POST | Filtered list / create. GET takes `status`, repeated `label`, repeated literal `search` terms, and a validated `query`. |
| `/git-bug/v1/issues/:id` | GET | Detail with comments. |
| `/git-bug/v1/issues/:id/comments` | POST | Add a comment. |
| `/git-bug/v1/issues/:id/status` | POST | Open or close. |
| `/git-bug/v1/issues/:id/labels` | POST | Add or remove one label. |
| `/git-bug/v1/sync` | POST | Push or pull. |
| `/git-bug/v1/identity` | GET / POST | Read or create the identity. |

Failures keep their classification: `400` a filter that is not valid git-bug syntax, `404` no such
bug, `409` repository not writable yet (no identity / not a git repository), `503` git-bug missing,
`504` timeout.

## Repository layout

```
index.js                 package entry (re-exports the server plugin)
cordis.patch.yml         the loader row
src/git-bug.js           git-bug CLI adapter: argv, JSON normalization, failure classes, lock queue
src/query.js             the filter vocabulary: literal terms, and a validated query parser
src/format.js            text projections (list, detail, digest)
src/subprocess-runner.js execution through ctx.subprocess
src/server/index.js      plugin: config, tools, prompt section, API mount
src/server/tools.js      the git_bug_* tool family
src/server/prompt.js     the system-prompt section
src/server/api.js        the panel's JSON API
src/client/factory.js    browser half (slot registrations + panel)
src/client/styles.css    panel styles, inlined into the bundle at build time
scripts/build-client.mjs wraps the browser half into the loader format and inlines styles.css
scripts/stub-provider.mjs a DeepSeek-compatible stand-in used by the harness test
tests/                   node:test suites
```

## Develop and verify

```sh
nix develop
npm run check     # build the browser half, then run every test suite
npm test          # tests only
npm run build     # browser half only
```

Suites:

| Suite | What it proves |
|---|---|
| `tests/git-bug.test.mjs` | The adapter against the real executable: create/read/comment/label/close round trips, long bodies over stdin, remote push into a second clone, failure classes, timeouts. |
| `tests/format.test.mjs` | Text projections. |
| `tests/api.test.mjs` | The HTTP API on a real server: every endpoint, error statuses, identity bootstrap, sync round trip. |
| `tests/plugin.test.mjs` | Activation: tool surface and schemas, prompt section content and ordering, route mount, headless composition, config validation. |
| `tests/client.test.mjs` | The built browser half: loader handoff, slot registrations, visibility source, API error mapping, and a render of the panel with fetched issue data (skipped when no React install is resolvable). |
| `tests/harness.test.mjs` | The whole loop: boots `dsh --profile headless --patch cordis.patch.yml` against a stub provider, then asserts the prompt section is present, every step of a writing turn reused a **byte-identical** system prompt, all eight tools are offered with valid schemas, and a `git_bug_create` round trip really writes to git-bug. Skipped when no `@deepseek-ai/dsh` install is resolvable. |

The render and harness suites resolve React and the harness packages from an installed profile
(`${DSH_HOME:-~/.config/dsh}/profiles/node_modules`); set `DSH_TEST_NODE_MODULES` to another
`node_modules` directory to override.

## Checks

Runs below were executed in this repository on the date shown, inside `nix develop`
(node v24.21.0, git-bug v0.11.0, dsh 0.2.2-rc.1, linux x86_64).

| Check | Command | Result |
|---|---|---|
| Test suite | `npm run check` | 39 tests, 39 pass, 0 fail |
| Live web profile | `dsh --profile web --patch <pkg>/cordis.patch.yml` against a scratch `DSH_HOME` | boots; `__DSH_BOOT__` carries the `dsh-git-bug` row at `/plugins/dsh-git-bug/client.js`, the bundle is served 200, `/git-bug/v1/overview` reports the bound repository, and API create/comment/status/label writes landed in git-bug |
| ENTRY (static) | `npx -p dsh-standards dsh-standards . --scope entry --entry-claim static --runtime-version 0.2.2-rc.1` | `status=pass`, `DSH-ENTRY recognized`, blocking 0, WARN DSC-11 (`C-11.5`, see below) |
| ENTRY (runtime) | `npx -p dsh-standards dsh-standards . --scope entry --entry-claim runtime --runtime <cordis>/lib/index.js --runtime-version 0.2.2-rc.1` | `status=pass`, `DSH-ENTRY runtime`, blocking 0; DSC-04/06/07/09/14 PASS; WARN DSC-08 (`C-8.2`, revision/epoch unchanged under L1) |
| FLOW | not run | `not-run` — no J1–J8 flow evidence collected |
| BOOST | not measured | `not-measured` — no LEV evidence cards |

`DSC-03` did not run in either report: it needs an install spec, and the package profile does not
carry one. These are check results, not a certification; a static result is not a runtime result.

### The browser half's build

`lib/client.js` is generated: `scripts/build-client.mjs` wraps `src/client/factory.js` in the loader
registration the web client expects and injects `src/client/styles.css` as a string constant inside
the factory closure. This mirrors the first-party client preset, which compiles `.module.css` files
at build time and emits the rules beside the code — styles are authored, reviewed and diffed as CSS
while the browser still receives one script.

Two guards keep it honest (`tests/build.test.mjs`): every selector in the stylesheet must appear in
the built bundle (a stale build fails the suite), and no line in `factory.js` may exceed 400
characters (CSS leaking back into code fails the suite). There is no bundler, so no class-name
hashing — the `gb-` prefix is this plugin's namespace by convention.

## Declared capabilities

`dsh.capabilities` in `package.json` declares what the plugin touches: `tools:register`,
`system-prompt:write`, `subprocess` (every git-bug command runs through `ctx.subprocess`),
`network:ingress` (the panel API mounted on the harness web server) and `network:egress` (the
browser half's `fetch` calls to that same-origin API).

`network:ingress` is declared but not visible to a static trigger scan, because the route is
mounted through the optional service — `ctx.inject(['webServer'], sub => sub.webServer.register(…))`
— so the plugin still loads in headless profiles where no web server exists. The declaration is
real; only its spelling is outside the scanner's trigger surface.

## Limits

- One repository per plugin instance (`repoPath`); mount several rows with different `repoPath`
  values to cover several workspaces.
- git-bug takes an exclusive per-repository lock. The adapter serializes every command and retries a
  transient lock a bounded number of times; a concurrent `git-bug` from another process is reported
  as `locked` rather than retried forever.
- No git-bug *bridge* support (`git-bug bridge` to GitHub/GitLab/Jira): issues are synchronized
  through git remotes only.
- The panel does not render comment markdown; issue text is shown verbatim.
- Product copy is English, with a Simplified Chinese translation selected from the browser language.

## License

MIT.