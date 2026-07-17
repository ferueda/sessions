import { registerSessionSourceContract } from "../../contracts/session-source.contract.ts";
import { createCursorSessionSourceContractFixture } from "../../fixtures/cursor/source-contract.ts";

registerSessionSourceContract("Cursor", createCursorSessionSourceContractFixture);
