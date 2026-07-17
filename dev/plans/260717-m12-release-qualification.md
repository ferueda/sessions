# Qualify and automate npm releases

## Goal

Make `@ferueda/sessions` installable without a source checkout and make every
supported release come from one reviewed, cross-platform-qualified tarball
published through npm trusted publishing. M12 ends with `0.1.0` as the first
supported `latest` release and with its matching packaged skill installable from
the immutable `v0.1.0` tag.

The npm package does not exist yet, this machine is not logged into npm, and the
repository has no release environment. Those are human-owned rollout gates, not
reasons to weaken local qualification. Current npm also requires a package to
exist before trusted publishing can be configured, so use one manually
published `0.0.0` bootstrap seed under the non-default `bootstrap` tag. It is
not a supported release, has no provenance, and establishes no data-compatibility
or migration promise. The next `0.1.0` publish is the first supported release,
the compatibility baseline for retained Sessions data, and must use GitHub OIDC
with verified provenance.

Two current packaging defects are part of M12: npm 11.17 removes
`./dist/bin/sessions.js` from the normalized `bin` map, and the contributor-only
`prepare: simple-git-hooks` lifecycle leaks into ordinary installs. The release
must not proceed until the binary survives npm normalization and the published
manifest has no install lifecycle hook.

## Changes

1. `package.json`, `docs/contributing/setup.md`, and
   `docs/contributing/commands.md` — make the manifest safe for ordinary npm
   installation. Change `bin.sessions` to `dist/bin/sessions.js`; remove the
   published `prepare` lifecycle; expose Git-hook setup as an explicit
   contributor-only command; and include `CHANGELOG.md`, the Release Please
   JSON files, and release workflow files in repository formatting. Keep
   `prepack` as the build owner, keep the compiled Node minimum, and do not add
   `postinstall`, initialization, provider reads, or Sessions-data mutation.

2. `release-please-config.json`, `.release-please-manifest.json`, `CHANGELOG.md`,
   and `test/release-configuration-contract.test.ts` — configure one root Node
   package in manifest mode at `0.0.0`, with `vX.Y.Z` tags and no component
   prefix. Seed history from foundation commit
   `601f92462ba24b9529cb90fda342344a22508a90` so the first release PR summarizes
   M1 through M12 rather than only the final delivery commits. Configure the
   generic extra-file updater for exactly one valid version marker in the agent
   setup guide. Parse both JSON files in the focused contract and prove the root
   package, manifest seed, foundation SHA, tag policy, and version-marker owner
   before automation runs. Conventional commits remain the release input; no
   independent version owner is added.

3. `scripts/package-artifact.ts`, `scripts/smoke-package.ts`, and
   `test/package-release-contract.test.ts` — extract the current tarball
   inventory, packaged-skill validation, and installed-package checks into one
   reusable package-artifact owner. Keep routine package validation independent
   of public tag state, and expose two explicit release-qualification modes:
   `bootstrap` requires package and manifest version `0.0.0` while rejecting a
   `v0.0.0` tag or supported changelog release; `supported` requires package,
   manifest, changelog release, and the expected `v<version>` tag name. Before
   release creation, that tag must be absent or already point to the exact
   release SHA on a retry; a conflicting ref fails. After release creation it
   must exist at that SHA. Cover a fresh release, matching retry, and conflicting
   tag. Select `bootstrap` only from the manual bootstrap dispatch and
   `supported` only from a validated push-mode release target. Preserve the
   existing offline
   `smoke:package` path and shared `scripts/smoke-workflow.ts`; do not create a
   second CLI journey. Strengthen the stable contract to prove:
   - the normalized package keeps the `sessions` executable;
   - the published manifest contains no install lifecycle script;
   - the exact allowlist contains compiled output, the ten skill files, and
     public root files but no source, tests, scripts, plans, or private paths;
   - both release modes enforce their distinct metadata and no-tag/tag
     contracts; and
   - npm publish dry-run in a disposable staging directory emits no manifest
     correction and leaves the checkout unchanged.
     Release qualification, normalization, and publish dry-run use exactly
     `npm@11.17.0`; do not rely on the older npm bundled with the minimum Node
     runtime. Routine offline package smoke remains compatible with the
     repository's ordinary Node setup.

4. `scripts/smoke-release-package.ts` and `package.json:scripts` — add an
   explicit release-only smoke that accepts one already-built tarball and its
   expected SHA-256. Install that artifact with ordinary npm, without
   `--ignore-scripts`, into an isolated global prefix; invoke the installed
   `sessions` shim; run help, version, doctor, paths, and the existing shared
   synthetic index/search/show/export/forget/clear workflow; and validate the
   packaged skill. Exercise the same tarball through an isolated `npx` trial.
   Capture command output and fail on npm corrections, lifecycle warnings,
   source-checkout resolution, version drift, unexpected files, or a dirty
   checkout. This release-only path may use the registry for dependencies;
   routine `pnpm check` remains network-free after dependency installation.

5. `.github/workflows/release.yml`, `scripts/release-order.ts`,
   `test/release-order.test.ts`, and
   `test/release-workflow-contract.test.ts` — add one non-cancelling workflow
   for `push` to `main` plus a manual bootstrap-qualification dispatch. Pin
   every third-party action to a reviewed full commit SHA with a version
   comment, use GitHub-hosted runners, set explicit timeouts, and disable
   package-manager caching. Keep registry-order decisions in the focused,
   deterministic script rather than shell conditionals. Model two event modes
   explicitly:
   - `workflow_dispatch` is qualification-only. It requires the selected ref to
     be `main`, package and manifest version `0.0.0`, and the bootstrap
     automation input. It runs the exact-SHA `pnpm check`, build/hash/upload,
     and all three release-package smoke jobs, then ends with the artifact and
     digest. It never resolves App credentials and cannot reach Release Please
     PR/release, tag, protected environment, npm publish, or registry
     verification jobs;
   - `push` mode may create a release PR only when release automation is
     enabled. It may enter release qualification and mutating jobs only when
     the parent revision already contains the root manifest, the root version
     changes, and the new SemVer is at least `0.1.0`. The initial
     absent-to-`0.0.0` manifest seed is always `release_target=false`, including
     a rerun after automation is enabled; that rerun may open the first Release
     Please PR but cannot enter qualification, tag, or publish jobs. An ordinary
     main push otherwise ends after the PR-management job. Within push mode,
     keep the phases and credentials separate:
   - a Release Please PR job mints a short-lived token from a dedicated,
     current-repository GitHub App and runs manifest mode with GitHub-release
     creation skipped; gate this job behind an explicit repository variable so
     merging the workflow before external setup does not fail every `main`
     build. The App may write contents, pull requests, and issues only. Do not
     use a maintainer PAT. App-authored release PRs must receive the existing
     review and Linux/macOS/Windows CI checks;
   - a release-target step detects a root-manifest version change on the exact
     merged revision and validates `package.json`, manifest, changelog, and
     `v<version>` alignment. Before producing any tarball, an Ubuntu release
     gate provisions and asserts exactly `npm@11.17.0`, installs frozen
     dependencies without caching, and runs the canonical `pnpm check` from
     that exact SHA. The independently triggered main CI and the release-PR
     checks do not satisfy this dependency;
   - after the exact-SHA gate passes, the same job builds and hashes one
     tarball on Ubuntu;
   - Linux, macOS, and Windows jobs download that same artifact, verify its
     digest, and run the release-package smoke without rebuilding it;
   - only after all three jobs pass, a release-only job mints a new App
     installation token with the documented Release Please minimum:
     `contents: write`, `pull-requests: write`, and `issues: write`. Release
     Please runs with pull-request creation skipped; the PR/issue permissions
     cover its merged-PR metadata, comment, and label lifecycle rather than new
     PR creation. The token is not reused from the PR-management job and
     receives no Actions, environment, or OIDC permission. It creates the tag
     only when absent, accepts only an existing exact-SHA tag on retry, and
     fails on a conflicting ref. The exact-tag skill route is then checked with
     a pinned supported `skills` installer and telemetry disabled;
   - the publish job uses a protected `npm` environment and has only
     `contents: read` plus `id-token: write`. It asserts Node `>=24.16.0` and npm
     `11.17.0`, downloads and verifies the same tarball, and publishes without
     `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or another registry secret. Give publish a
     non-cancelling, target-version-specific concurrency group so duplicate
     attempts for one version cannot mutate npm concurrently. Before any new
     publish, require registry `latest` to equal the parent manifest version.
     The sole first-release exception requires target `0.1.0`, no current
     `latest`, and `bootstrap` exactly `0.0.0`. A version that already exists is
     a no-op only when its integrity matches the qualified artifact; if `latest`
     is newer, treat it as a stale verified retry and never move the tag
     backward. Any absent target with unexpected `latest` fails before mutation
     and is rerun after the missing earlier release completes;
   - final verification checks registry version, executable mapping, engine,
     repository, `latest` tag, artifact integrity, global install, and
     signatures/provenance. A tag that exists after a partial failure must point
     to the original release revision; recovery reruns that revision and never
     rebuilds from newer `main`.
     The focused workflow contract reads the checked-in YAML and proves that the
     manual bootstrap mode reaches the exact-SHA gate, artifact build, and every
     platform smoke while every credentialed or mutating job is unreachable. It
     covers the initial manifest-addition push and its configured rerun, proving
     both remain non-release targets while PR management becomes reachable on the
     rerun. It also fails if the push-only release-PR App token, release-only
     documented App permission block, publish
     `contents: read`/`id-token: write` block, protected `npm`
     environment, exact dependency chain, pinned npm provisioning,
     release-order preflight, or cache-disabled exact-SHA `pnpm check` drifts.
     Focused release-order fixtures cover the `0.1.0` bootstrap transition,
     normal parent-to-child publication, missing-parent/out-of-order failure,
     exact retry, stale retry after a newer release, and integrity conflict. The
     contract also rejects `NPM_TOKEN`, `NODE_AUTH_TOKEN`, registry secrets,
     broad workflow permissions, and OIDC on any non-publish job.

6. `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/getting-started.md`,
   `docs/agent-setup.md`,
   `docs/reference/agent-skill.md`, `docs/troubleshooting.md`, `docs/privacy.md`,
   `docs/contributing/setup.md`, and
   `test/docs-contracts.test.ts` — prepare and then cut over public onboarding
   without advertising an unavailable release. The initial automation merge
   keeps source-checkout onboarding current and labels npm plus immutable-tag
   agent setup as planned. The `0.1.0` release PR owns a reviewed follow-up
   commit that switches those routes to current before it can merge. Make the
   docs contract read the release manifest: version `0.0.0` requires planned npm
   wording and current source-checkout setup, while `>=0.1.0` requires current
   npm and immutable-tag instructions and contributor-only source setup. The
   supported state is:
   - global `npm install --global @ferueda/sessions@<version>` is primary and
     `npx --yes @ferueda/sessions@<version>` is trial-only;
   - the agent guide pins the CLI version and matching
     `https://github.com/ferueda/sessions/tree/v<version>/skills/sessions`
     source, pins the supported external skill installer, discloses its network
     boundary, disables its anonymous telemetry in the documented command, and
     verifies `sessions --version`, `doctor`, and `paths`;
   - agent setup stops before `index` until it explains provider-history reads
     and durable Sessions-owned writes and receives separate permission;
   - upgrades change CLI and skill together; uninstalling either does not delete
     retained Sessions data; and global npm permission recovery uses a Node
     version manager or user-local prefix, never `sudo`.
     Release Please owns exact version markers but does not silently change route
     status; the release-PR follow-up owns that wording cutover. Keep `doctor` and
     `paths` read-only and keep explicit
     `index --source <source>` as the only initialization path. Do not add an
     `init` alias, wizard, shell-piped installer, self-updater, or automatic data
     deletion. Replace every “first published release” compatibility statement
     with the exact cutover: `0.0.0` under `bootstrap` is an unsupported package
     seed with no data-preserving migration promise; `0.1.0` is the first
     supported release and begins the retained-data compatibility contract.

7. `docs/decisions/0009-establish-the-supported-release-baseline.md`,
   `docs/decisions/README.md`,
   `docs/decisions/0004-publish-a-compiled-node-cli.md`,
   `docs/decisions/0007-retain-a-durable-canonical-library.md`,
   `docs/decisions/0008-explicit-orphan-content-repair.md`,
   `docs/reference/cli-contract.md`,
   `docs/reference/structured-output.md`,
   `docs/contributing/releasing.md`, `docs/contributing/index.md`,
   `docs/contributing/testing.md`, `docs/contributing/architecture.md`,
   `docs/architecture-memo.md`, and
   `dev/plans/260713-v1-implementation-roadmap.md` — document the current
   release ownership, exact artifact flow, credential boundaries, failure
   recovery, and the bootstrap-versus-supported-release distinction. Record
   that release qualification is additive to ordinary CI and that npm/GitHub
   account, environment, App, and trusted-publisher changes are maintainer
   operations outside repository tests. Add an accepted ADR that narrowly
   supersedes ADR 0004's trusted-publisher-before-first-release prerequisite for
   the sole unsupported `0.0.0` bootstrap seed, and supersedes only the
   first-publication consequences of ADRs 0007 and 0008. Cross-link it from all
   three prior records. The exception ends once the package exists: `0.1.0` is
   the first supported release and every supported release requires trusted
   publishing and provenance. It is also the first retained-data, CLI, and
   structured-output compatibility baseline. Keep every other accepted
   delivery, retention, and repair decision intact. Reconcile the CLI and
   structured-output references, M12 roadmap wording, and the focused
   docs-contract assertions so “first supported release” rather than the
   immutable bootstrap seed owns the provenance and compatibility requirements.

## Rollout

1. Merge the repository implementation with release automation disabled. Run
   the manual bootstrap-qualification dispatch at the exact merged `0.0.0`
   revision and download its one qualified tarball plus digest.
2. Stop unless `npm whoami`, account-level 2FA, `@ferueda` scope ownership,
   package availability, and public access are confirmed. Publish only that
   qualified tarball interactively with maintainer 2FA, explicit public access,
   `--tag bootstrap`, and provenance disabled. Do not create a Git tag or
   assign `latest`.
3. Create the dedicated repository GitHub App, store only its App ID and private
   key in repository Actions configuration, and create the protected `npm`
   environment with a maintainer approval gate. Because this is currently a
   one-maintainer repository, do not enable prevent-self-review.
4. With npm `11.17.0`, bind `@ferueda/sessions` to the exact repository,
   `release.yml` filename, `npm` environment, and `npm publish` operation.
   Verify the binding, then enable the repository release-automation variable.
   Re-run all jobs from the original implementation-merge `release.yml` push
   run at the same SHA; repository variables and App credentials are resolved
   on that new attempt, which now runs the push-only PR-management job. Do not
   use the qualification-only manual dispatch for this transition.
5. Let Release Please open the `0.1.0` PR. Add the planned-to-current onboarding
   cutover commit to that PR; the manifest-aware docs contract must keep the PR
   failing until this is done. Approve and merge only after the ordinary
   required checks pass. Approve the protected publish job after its exact
   tarball passes all three release-smoke jobs.
6. Verify `0.1.0` is `latest`, its Git tag resolves to the release revision, its
   registry integrity matches the tested tarball, provenance/signatures pass,
   and both human and agent setup journeys work from public endpoints. Only
   then disallow npm token publishing and revoke obsolete automation tokens.

## Verify

- `pnpm test test/package-release-contract.test.ts test/release-configuration-contract.test.ts test/release-order.test.ts test/release-workflow-contract.test.ts test/docs-contracts.test.ts test/skill-contracts.test.ts`
- `pnpm build && pnpm smoke:package`
- Run the release-package smoke against one local tarball and confirm ordinary
  global npm installation, the shim, `npx`, the packaged skill, and the shared
  synthetic workflow pass without install scripts or a source checkout.
- `pnpm check`
- Before any external publish, complete every rollout stop gate. After
  `0.1.0`, verify registry metadata, integrity, `latest`, immutable tag skill
  installation, and `npm audit signatures` from fresh temporary locations.

## Boundaries

- No real publish, GitHub App/environment mutation, npm trusted-publisher
  mutation, token revocation, or release-automation enablement is implied by
  implementing the repository change; each is an explicit maintainer rollout
  action.
- No backward-compatible support for unpublished development package metadata
  or source-checkout installation is required.
- No Homebrew tap, standalone binary, shell installer, setup wizard, `init`
  command, postinstall hook, self-updater, or custom skill-directory manager.
- No provider read, indexing, Sessions-data mutation, or retained-data deletion
  occurs during package installation, upgrade, uninstall, `doctor`, or `paths`.
- Recheck the official npm trusted-publisher, npm trust, Release Please, GitHub
  OIDC, and GitHub token-trigger documentation during implementation. Stop if
  current prerequisites contradict the bootstrap, token, workflow, or
  provenance design rather than silently adapting release authority.
