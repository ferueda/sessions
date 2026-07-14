import { registerSessionSourceContract } from "./session-source.contract.ts";
import { createSyntheticSourceFixture } from "../fixtures/synthetic-source.ts";

registerSessionSourceContract("synthetic", createSyntheticSourceFixture);
