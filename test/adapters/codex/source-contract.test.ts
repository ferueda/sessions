import { registerSessionSourceContract } from "../../contracts/session-source.contract.ts";
import { createCodexSessionSourceContractFixture } from "../../fixtures/codex/source-contract.ts";

registerSessionSourceContract("Codex", createCodexSessionSourceContractFixture);
