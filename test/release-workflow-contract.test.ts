import { readFile } from "node:fs/promises";
import path from "node:path";

import { beforeAll, describe, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
let workflow = "";

beforeAll(async () => {
  workflow = await readFile(path.join(root, ".github/workflows/release.yml"), "utf8");
});

describe("release workflow contract", () => {
  test("pins reviewed actions and disables release caches", () => {
    const uses = [...workflow.matchAll(/uses: ([^@\s]+)@([^\s]+) # (v[^\s]+)/gu)];

    expect(uses.length).toBeGreaterThan(0);
    for (const [, action, revision, version] of uses) {
      expect(action).toMatch(/^[\w.-]+\/[\w.-]+$/u);
      expect(revision).toMatch(/^[a-f0-9]{40}$/u);
      expect(version).toMatch(/^v\d+\.\d+\.\d+$/u);
    }
    expect(workflow).not.toMatch(/uses: [^@\s]+@v\d/gu);
    expect(workflow).toContain("package-manager-cache: false");
    expect(workflow).not.toMatch(/cache:\s+(?:pnpm|npm|yarn)/gu);
    expect(workflow).toContain("npm install --global npm@11.17.0");
  });

  test("keeps bootstrap qualification separate from push release mutation", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("bootstrap:");
    expect(workflow).toContain("retry_release:");
    expect(workflow).toContain("artifact_run_id:");
    expect(workflow).toContain("artifact_sha256:");
    expect(workflow).toContain("push:");
    expect(workflow).toContain("branches:\n      - main");

    const releasePr = jobBlock("release-pr");
    const qualify = jobBlock("qualify");
    const smoke = jobBlock("smoke-release");
    const createRelease = jobBlock("create-release");
    const publish = jobBlock("publish");

    expect(releasePr).toContain(
      "if: github.event_name == 'push' && vars.RELEASE_AUTOMATION_ENABLED == 'true'",
    );
    expect(qualify).toContain("if: needs.route.outputs.qualify == 'true'");
    expect(qualify).toContain("scripts/release-order.ts assert-checkout");
    expect(qualify).toContain("pnpm check");
    expect(qualify).toContain('--mode "$RELEASE_MODE"');
    expect(qualify).toContain("--tag-phase before");
    expect(qualify).toContain("${{ runner.temp }}/sessions-release-artifact");
    expect(qualify).toContain("${{ runner.temp }}/release-artifact-report.json");
    expect(qualify).not.toContain("--output-directory release-artifact");
    expect(qualify).toContain("GITHUB_STEP_SUMMARY");
    expect(qualify).toContain("QUALIFICATION_MODE");
    expect(qualify).toContain("ARTIFACT_FILENAME");
    expect(qualify).toContain("ARTIFACT_SHA256");
    expect(smoke).toContain("matrix.os");
    expect(smoke).toContain("ubuntu-latest");
    expect(smoke).toContain("macos-latest");
    expect(smoke).toContain("windows-latest");
    expect(smoke).toContain("scripts/smoke-release-package.ts");
    expect(createRelease).toContain(
      "if: >-\n      github.event_name == 'push' &&\n      vars.RELEASE_AUTOMATION_ENABLED == 'true' &&\n      needs.route.outputs.release_target == 'true'",
    );
    expect(publish).toContain("always() &&");
    expect(publish).toContain("github.event_name == 'push' &&");
    expect(publish).toContain("vars.RELEASE_AUTOMATION_ENABLED == 'true' &&");
    expect(publish).toContain("needs.route.outputs.release_target == 'true' &&");
    expect(publish).toContain("needs.create-release.result == 'success'");
  });

  test("uses separate least-privilege GitHub App tokens", () => {
    for (const job of ["release-pr", "create-release"] as const) {
      const block = jobBlock(job);
      expect(block).toContain(
        "actions/create-github-app-token@f8d387b68d61c58ab83c6c016672934102569859 # v3.0.0",
      );
      expect(block).toContain("app-id: ${{ vars.RELEASE_APP_ID }}");
      expect(block).toContain("private-key: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}");
      expect(block).toContain("owner: ${{ github.repository_owner }}");
      expect(block).toContain("repositories: ${{ github.event.repository.name }}");
      expect(block).toContain("permission-contents: write");
      expect(block).toContain("permission-pull-requests: write");
      expect(block).toContain("permission-issues: write");
    }
    expect(jobBlock("release-pr")).toContain("skip-github-release: true");
    expect(jobBlock("create-release")).toContain("skip-github-pull-request: true");
    expect(jobBlock("create-release")).toContain(
      'git fetch --force --no-tags origin "refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"',
    );
    expect(jobBlock("create-release")).toContain("scripts/package-artifact.ts verify-tag");
    expect(jobBlock("create-release")).toContain('DISABLE_TELEMETRY: "1"');
    expect(jobBlock("create-release")).toContain("skills@1.5.19");
  });

  test("gives only the protected publish job OIDC", () => {
    const publish = jobBlock("publish");

    expect(workflow.match(/id-token: write/gu)).toHaveLength(1);
    expect(publish).toContain("environment:\n      name: npm");
    expect(publish).toContain(
      "permissions:\n      actions: read\n      contents: read\n      id-token: write",
    );
    expect(publish).toContain("group: npm-${{ needs.route.outputs.version }}");
    expect(publish).toContain("cancel-in-progress: false");
    expect(publish).toContain(".release-automation/scripts/release-order.ts prepublish");
    expect(publish).toContain('--sha256 "$QUALIFIED_SHA256"');
    expect(publish).toContain("if: steps.order.outputs.action == 'publish'");
    expect(publish).toContain('npm publish "$TARBALL" --access public');
    expect(publish).toContain(".release-automation/scripts/release-order.ts verify-registry");
    expect(publish).toContain("npm audit signatures");
    expect(publish).toContain("ref: ${{ needs.route.outputs.release_sha }}");
    expect(publish).toContain("path: .release-automation");
    expect(publish).toContain("run-id: ${{ inputs.retry_release");
    expect(publish).toContain("github-token: ${{ github.token }}");
    expect(publish).toContain("inputs.retry_release == true");
    expect(publish).toContain("inputs.artifact_run_id != ''");
    expect(publish).toContain("inputs.artifact_sha256 != ''");
    expect(workflow.match(/registry-url: https:\/\/registry\.npmjs\.org/gu)).toHaveLength(1);
    expect(publish).toContain("registry-url: https://registry.npmjs.org");
    expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.NPM/gu);
  });

  test("passes one qualified artifact through every release phase", () => {
    const qualify = jobBlock("qualify");
    const smoke = jobBlock("smoke-release");
    const createRelease = jobBlock("create-release");
    const publish = jobBlock("publish");

    expect(qualify).toContain(
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2",
    );
    expect(smoke).toContain("name: sessions-${{ needs.qualify.outputs.version }}");
    expect(publish).toContain("name: sessions-${{ needs.route.outputs.version }}");
    expect(smoke).toContain("${{ runner.temp }}/sessions-release-artifact");
    expect(publish).toContain("${{ runner.temp }}/sessions-release-artifact");
    expect(smoke).not.toContain("path: release-artifact");
    expect(smoke).toContain('--sha256 "${{ needs.qualify.outputs.sha256 }}"');
    expect(publish).not.toContain("path: release-artifact");
    expect(jobBlock("release-pr")).toContain("needs: route");
    expect(qualify).toContain("needs: route");
    expect(smoke).toContain("needs:\n      - route\n      - qualify");
    expect(createRelease).toContain(
      "needs:\n      - route\n      - release-pr\n      - qualify\n      - smoke-release",
    );
    expect(publish).toContain(
      "needs:\n      - route\n      - qualify\n      - smoke-release\n      - create-release",
    );
  });
});

function jobBlock(name: string): string {
  const header = `  ${name}:\n`;
  const start = workflow.indexOf(header);
  if (start === -1) throw new Error(`missing workflow job: ${name}`);
  const remainder = workflow.slice(start + header.length);
  const next = /^  [a-z][\w-]*:\n/mu.exec(remainder);
  return remainder.slice(0, next?.index ?? remainder.length);
}
