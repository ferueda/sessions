# Releasing

- Status: current

Sessions uses Release Please, one exact qualified tarball, a protected GitHub
environment, and npm trusted publishing.

## Routine release

1. Merge normal changes to `main` with conventional commit or PR titles.
   Release Please normally maps `fix:` to a patch, `feat:` to a minor, and a
   breaking change to a major release.
2. Review the generated Release Please PR. Confirm its version, changelog, and
   public version markers, then merge it after required CI passes.
3. The release workflow checks the exact merge revision, runs `pnpm check`,
   builds one tarball, and smokes those bytes on Linux, macOS, and Windows.
4. Automation creates and verifies the immutable `vX.Y.Z` tag and GitHub
   release.
5. Approve the protected `npm` environment only after qualification and all
   package smokes pass.
6. The protected job publishes the qualified tarball through npm trusted
   publishing, then verifies registry metadata, `latest`, integrity, a clean
   install, signatures, and SLSA provenance.

If more changes reach `main` before the release PR merges, Release Please updates
the same PR. Do not edit versions or tags manually and do not run `npm publish`
for a supported release.

## Ownership and permissions

- Release Please owns `package.json`, `.release-please-manifest.json`,
  `CHANGELOG.md`, public version markers, and `vX.Y.Z` tags.
- A repository GitHub App opens release PRs and creates releases with short-lived
  tokens. PR and release phases mint separate tokens.
- Ordinary required CI reviews the release PR.
- Only the protected `npm` job receives `id-token: write`.
- npm publication uses GitHub OIDC. No npm token is stored.
- Release qualification is additive to ordinary CI.

The App ID is stored as `RELEASE_APP_ID`; its private key is stored as
`RELEASE_APP_PRIVATE_KEY`. The protected environment is named `npm`.
`RELEASE_AUTOMATION_ENABLED=true` keeps routine automation active.

Recheck the official
[npm trusted-publisher](https://docs.npmjs.com/trusted-publishers/) and
[Release Please](https://github.com/googleapis/release-please-action)
requirements before changing external configuration.

## Failed publication

If publication fails after qualification and GitHub release creation, dispatch
the `Release` workflow on `main` with:

- `retry_release=true`;
- the original qualifying workflow run ID;
- the SHA-256 from its qualification summary.

The retry resolves the immutable release tag, downloads and verifies the
original artifact, and uses the current release-order guard. It does not rebuild
from newer `main`, move the tag, or move `latest` backward.

The protected publish job retries only npm's known transient
attestation-endpoint 404, for at most 25 seconds. Other signature or provenance
failures stop immediately.

Recovery rules:

- An existing version is a no-op only when registry integrity matches the
  qualified artifact.
- An existing tag must already point to the release revision.
- A stale retry after a newer release verifies its target without moving
  `latest` backward.
- Unexpected registry ordering fails before mutation.
- Never place npm tokens, App private keys, transcript data, or provider paths in
  logs or artifacts.

## Completed bootstrap

npm trusted publishing required the package to exist first. The repository used
one exact manually qualified `0.0.0` tarball with maintainer 2FA and the
non-default `bootstrap` tag. That seed has no GitHub release, supported API, or
migration promise.

`0.1.0` replaced it as `latest` and established compatibility for retained data,
CLI behavior, and structured output. Do not republish, retag, or present the
bootstrap seed as an end-user release. See
[ADR 0009](../decisions/0009-establish-the-supported-release-baseline.md).
