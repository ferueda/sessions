# Security policy

Sessions processes private local transcripts. Do not include transcripts, tokens, secrets, provider databases, home-directory paths, or other personal data in a public issue.

## Reporting

Use [GitHub private vulnerability reporting](https://github.com/ferueda/sessions/security/advisories/new) for suspected vulnerabilities or privacy failures. Include the smallest synthetic reproduction possible and describe affected versions, impact, and platform.

If private reporting is unavailable, open a public issue containing no sensitive details and ask for a private contact channel.

## Supported versions

Security fixes target supported Sessions releases beginning with `0.1.0`.
Current supported release: 0.1.1 <!-- x-release-please-version -->

The unsupported `0.0.0` bootstrap seed establishes no support policy.

## Scope

High-priority reports include unintended source mutation, transcript/network leakage, insecure index permissions, path traversal, unsafe export behavior, package supply-chain compromise, and structured-output injection that violates documented boundaries.
