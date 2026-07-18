# Releasing

M12 adds one Release Please manifest, one release workflow, and one qualified
tarball per supported release. Repository tests do not configure npm, GitHub
Apps, environments, or trusted publishing.

## Release ownership

- Release Please owns package, manifest, changelog, and `vX.Y.Z` tag versions.
  `CHANGELOG.md` keeps Release Please's generated style and is excluded from
  repository formatting.
- Release Please also updates the pinned public-version markers in README,
  security, getting-started, agent-setup, and Agent Skill documentation.
- A dedicated GitHub App opens release pull requests with short-lived tokens.
  Its installation tokens are limited to this repository and
  contents/pull-requests/issues write; PR and release phases mint separate
  tokens.
- Ordinary required CI reviews the release pull request.
- The release workflow runs `pnpm check` again at the exact release revision,
  builds one tarball, and tests those bytes on Linux, macOS, and Windows.
- Only the protected `npm` job receives `id-token: write`. It publishes the same
  tarball through npm trusted publishing without an npm token.
- Registry version, `latest`, integrity, executable metadata, install, and
  provenance are verified after publication.

Release qualification is additive to ordinary CI. A failed publish is retried
from the original release revision; do not rebuild from newer `main` or move
`latest` backward.

## Bootstrap once

Trusted publishing requires the npm package to exist. The sole exception is an
interactive publication of the exact qualified `0.0.0` tarball with maintainer
2FA, public access, and the non-default `bootstrap` tag. Do not create
`v0.0.0` or treat that seed as supported. npm's public registry may also point
the required `latest` tag at the sole published version; the first supported
release accepts only `latest` absent or pointing to that exact seed and replaces
it with `0.1.0`.

After the manual bootstrap qualification passes, download its tarball and
digest, verify both, then publish those exact bytes:

```bash
export TARBALL='/path/to/qualified/ferueda-sessions-0.0.0.tgz'
export EXPECTED_SHA256='<sha256-from-the-qualification-summary>'
export ACTUAL_SHA256="$(
  node -e 'const fs=require("node:fs"); const crypto=require("node:crypto"); process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' \
    "$TARBALL"
)"
test "$ACTUAL_SHA256" = "$EXPECTED_SHA256"
npm whoami
npm publish "$TARBALL" \
  --access public \
  --tag bootstrap \
  --provenance=false
```

Stop before publishing unless the digest matches, `npm whoami` names the
intended maintainer, account 2FA protects package writes, that account can
publish public packages under `@ferueda`, and `@ferueda/sessions` is still
available for this bootstrap. If the package already exists, inspect it and
follow the recovery rules instead of replacing or rebuilding the artifact.

The npm-only seed has no GitHub release or tag. The Release Please
`initial-version` setting therefore pins the first release pull request to
`0.1.0`; the `0.0.0` manifest seed does not set that first-release version.

After the seed exists:

1. Create the repository GitHub App and store only its App ID and private key in
   repository Actions configuration as variable `RELEASE_APP_ID` and secret
   `RELEASE_APP_PRIVATE_KEY`.
2. Create the protected `npm` environment with maintainer approval. In the
   current one-maintainer repository, do not enable prevent-self-review.
3. With npm `11.17.0`, bind the exact repository, `release.yml`, `npm`
   environment, and `npm publish` operation as the trusted publisher:

   ```bash
   npm trust github @ferueda/sessions \
     --repo ferueda/sessions \
     --file release.yml \
     --env npm \
     --allow-publish \
     --yes
   npm trust list @ferueda/sessions --json
   ```

4. Set `RELEASE_AUTOMATION_ENABLED=true` and rerun the original
   implementation-merge push workflow at the same revision. The manual
   `bootstrap` dispatch qualifies `0.0.0` only; it cannot publish or open the
   release pull request.
5. Review the `0.1.0` Release Please pull request, including the planned-to-current
   onboarding cutover.
6. Approve publish only after the exact tarball passes all release jobs.
7. Verify `0.1.0` as `latest` with matching tag, integrity, and provenance, then
   disallow token publishing and revoke obsolete automation tokens.

The protected publish job retries only npm's known transient attestation-endpoint
404 for up to 25 seconds. Other signature or provenance failures stop
immediately.

If a publish fails after qualification and GitHub release creation, dispatch the
same `Release` workflow on `main` with `retry_release=true`, the original
qualifying run ID, and the SHA-256 from its qualification summary. The retry
resolves the immutable release tag, downloads the retained artifact from that
run, verifies its bytes, and uses the current reviewed release-order guard. It
does not move the tag or rebuild the package.

`0.1.0` is the first supported package and the compatibility baseline for the
CLI, structured output, and retained Sessions data. See
[ADR 0009](../decisions/0009-establish-the-supported-release-baseline.md).

## Recovery rules

- An absent first supported target accepts `latest` only when it is absent or
  still points to the exact `0.0.0` bootstrap seed.
- Any other absent target with an unexpected parent `latest` fails before
  mutation.
- An existing version is a no-op only when its registry integrity matches the
  qualified artifact.
- An existing tag must point to the release revision.
- If a newer release is already `latest`, verify the stale retry without moving
  the tag backward.
- Never place npm tokens, App private keys, transcript data, or provider paths in
  logs or artifacts.

Recheck the official
[npm trusted-publisher](https://docs.npmjs.com/trusted-publishers/) and
[Release Please](https://github.com/googleapis/release-please-action)
requirements before changing external configuration.
