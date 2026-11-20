# dsh-git-bug

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that makes
[git-bug](https://github.com/git-bug/git-bug) issues in the current workspace the agent's shared task
list and an **Issues** panel in the web client.

git-bug stores issues in git refs, so they are versioned, offline-first, and travel with the
repository's existing remote.

- Eight `git_bug_*` tools let the agent list, read, create, comment on, label, close and sync issues.
- The system prompt tells the agent when to use that list.
- A sidebar **Issues** panel shows and edits the same issues in the web client.
- English and Simplified Chinese copy follows the harness language setting.

## Requirements

- `git-bug` ≥ 0.11.0 on `PATH`
- `git` and a git repository as the harness working directory
- DeepSeek Harness `>=0.2.2-0 <0.3.0`

A repository without a git-bug identity still reads fine. The plugin creates one on activation
(`autoCreateIdentity`), so writes work without a separate setup step.

## Install

### Nix

```sh
nix develop
nix build .#plugin
nix run .#install
```

Nix sees only tracked files; commit the checkout before building.

### Home Manager

```nix
{
  inputs.dsh-git-bug.url = "github:you/dsh-git-bug";

  # wherever nixpkgs is instantiated
  nixpkgs.overlays = [ inputs.dsh-git-bug.overlays.default ];
}
```

```nix
{
  programs.deepseek-harness = {
    enable = true;
    settings.plugins = [
      pkgs.dshPlugins.dsh-git-bug
      # or with config:
      # (pkgs.dshPlugins.dsh-git-bug { repoPath = "/home/me/projects/thing"; })
    ];
  };
}
```

### Any package manager

The plugin is a plain ESM package with no runtime dependencies. Make it resolvable by name from the
profile:

```sh
ln -s "$PWD" "${DSH_HOME:-$HOME/.config/dsh}/node_modules/dsh-git-bug"
```

### Mount the row

The package ships `cordis.patch.yml`:

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
`${DSH_HOME:-~/.config/dsh}/cordis.patch.yml`. Use the `dsh` launcher rather than a bare `node`
invocation, so the loader can resolve out-of-tree rows by package name.

## Configuration

Config is read from the loader row:

```yaml
- id: dsh-git-bug
  config:
    repoPath: /home/me/projects/thing
    remote: origin
    taskLabel: agent-task
```

| Field | Default | Meaning |
|---|---|---|
| `repoPath` | `process.cwd()` | Repository the plugin reads and writes. `~/` expands. |
| `remote` | `origin` | Git remote used by sync. |
| `apiPath` | `/git-bug/v1` | Mount point of the panel's JSON API. |
| `taskLabel` | `ai` | Label the prompt tells the agent to put on work it owns. |
| `labelVocabulary` | the label table below | Replace any group of suggested labels. |
| `identity` | `{ name: 'DeepSeek Harness', email: 'harness@localhost' }` | Identity created in repositories that have none. |
| `autoCreateIdentity` | `true` | Create that identity at activation. |
| `promptSection` | `true` | Contribute the system-prompt section. |
| `promptOrder` | `120` | Section order (tool guidance lives at 100–199). |
| `sessionCue` | `true` | Inject a task-list cue at session start. |
| `todoNudge` | `true` | Remind the agent about git-bug the first time it calls `todo_write`. |
| `timeoutMs` | `30000` | Deadline for local git-bug commands. |
| `syncTimeoutMs` | `120000` | Deadline for push and pull. |

Invalid configuration throws at load.

## Tools

| Tool | Arguments | Purpose |
|---|---|---|
| `git_bug_list` | `status`, `labels[]`, `search[]`, `query`, `limit`, `sort`, `direction` | Read the shared list. |
| `git_bug_show` | `id` | One issue with all comments. |
| `git_bug_create` | `title`, `message`, `labels[]` | Put a unit of work on the list. |
| `git_bug_comment` | `id`, `message` | Progress, decisions, blockers. |
| `git_bug_status` | `id`, `status` | Open or close an issue. |
| `git_bug_label` | `id`, `label`, `action` | Add or remove a label. |
| `git_bug_sync` | `action`, `remote` | Push or pull the git remote. |
| `git_bug_identity` | `create`, `name`, `email` | Inspect or create the write identity. |

Ids may be full or the short human id shown in lists.

## The panel

The sidebar **Issues** action opens the panel over the conversation.

- Status chips and a filter box. The box accepts git-bug's query syntax, such as `label:ui` or
  `status:closed`.
- **Advanced** holds the label chips, sort order and paging.
- **Sync** pulls the remote and then pushes.
- Issue bodies and comments render as Markdown.
- The interface follows the harness language setting (English and Simplified Chinese).

## Labels

A starting vocabulary so the agent and you reach for the same words. It is a convention, not a
policy: any label is accepted, and `labelVocabulary` can replace any group.

| Group | Labels | Intended use |
|---|---|---|
| kind | `bug` `feature` `enhancement` `refactor` `docs` `todo` | What the issue is |
| priority | `priority/low` `priority/normal` `priority/high` `priority/urgent` | How soon |
| severity | `severity/minor` `severity/major` `severity/critical` `severity/blocker` | How bad; bugs only |
| state | `blocked` `needs-info` `duplicate` `wontfix` `cant-reproduce` | Why an issue is not simply open |
| ownership | `ai` | Work an agent owns |
| component | `component/<area>`, e.g. `component/panel` | Which part of the codebase |

Grouped labels use `/`, so `label:priority/high` works in a git-bug query without quoting.

## Limits

- One repository per plugin instance. Mount one row per repository.
- No git-bug bridge support (GitHub, GitLab, Jira); synchronization is through git remotes.
- git-bug takes an exclusive per-repository lock, so concurrent commands can report `locked`.
- Without the shell's Markdown renderer, issue text falls back to plain text.

## Development

```sh
nix develop
npm run check     # build the browser half, then run all tests
npm test          # tests only
npm run build     # browser half only
```

`lib/client.js` is generated from `src/client/`; edit the source and rebuild. The client and
harness suites need React and DSH packages from an installed profile; set `DSH_TEST_NODE_MODULES` to
another `node_modules` directory to override.

## License

MIT.
