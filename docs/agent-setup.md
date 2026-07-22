# Agent setup

- Status: current

The public npm and immutable-tag routes below are current. Do not install the
unsupported `0.0.0` bootstrap seed as an end-user release.

## Install the matching release

The agent may install the CLI and skill after the user approves network access
and global package changes:

```bash
export SESSIONS_VERSION='0.3.1' # x-release-please-version
npm install --global "@ferueda/sessions@${SESSIONS_VERSION}"
DISABLE_TELEMETRY=1 npx --yes skills@1.5.19 add \
  "https://github.com/ferueda/sessions/tree/v${SESSIONS_VERSION}/skills/sessions" \
  --skill sessions --agent codex --global --yes --copy
```

Use `--agent cursor` for Cursor. The external `skills` installer contacts the
package registry and GitHub. `DISABLE_TELEMETRY=1` disables its anonymous
telemetry for this command. Sessions runtime commands remain local,
network-free, and telemetry-free.

Do not use `sudo` to repair global npm permissions. Use a Node version manager
or a user-local npm prefix.

## Verify before indexing

```bash
sessions --version
sessions doctor --format json
sessions paths --format json
```

The reported Sessions version must equal `SESSIONS_VERSION`. This install or
upgrade check intentionally runs one exact doctor audit before paths. Doctor may
take minutes on a large library because it reads and validates all
Sessions-owned retained canonical transcript content. It never opens provider
transcript content. Paths is the fast readiness check and does not scan retained
transcript bodies. Neither command indexes, migrates, or creates persistent
state.

Stop here. Before running `sessions index`, explain that indexing reads local
Cursor or Codex history and writes a durable normalized copy into
Sessions-owned application data. Run the requested `index --source <source>`
only after the user gives separate permission for that read and write.

## Upgrade or uninstall

Upgrade the CLI and skill together to the same supported release tag. Re-run the
install commands with the new version, then repeat the verification commands.
Do not pair an npm version with a skill from mutable `main`.

For ordinary skill investigations after verification, use paths plus each
retained query's same-snapshot capture scope. Paths proves readiness, not the
deep canonical and FTS integrity that doctor audits.

```bash
npm uninstall --global @ferueda/sessions
```

Removing the CLI or skill does not delete retained Sessions data. Delete
Sessions-owned data only through an explicit supported data command or the
documented manual recovery path.
