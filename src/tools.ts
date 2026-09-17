// Fake side effects shared by every stage. The step files show how they are
// composed into durable operations; only the model calls are real.

import {log} from "./log.js";
import type {ToolCall, SandboxRef} from "./types.js";

/** Fake tools: deploy takes 3s, test takes 5s, everything else is instant.
 * `search` answers with a pointer to the other tools, so a real model knows
 * what to do next instead of searching again. */
export async function runTool(call: ToolCall, sandbox: SandboxRef): Promise<string> {
  const ms = call.toolName === "deploy" ? 3_000 : call.toolName === "test" ? 5_000 : 0;
  log("tool", `${call.id} ${call.toolName} running in ${sandbox.id}${ms ? ` (${ms / 1000}s)` : ""}`);
  await new Promise((resolve) => setTimeout(resolve, ms));
  log("tool", `${call.id} ${call.toolName} done`);
  return call.toolName === "search"
    ? "found: deploy with the deploy tool (env: staging), run the e2e suite with the test tool, lint with the lint tool"
    : `${call.toolName} ok`;
}

/** The guardrail: anything rm-shaped is blocked. */
export async function evaluateGuard(call: ToolCall): Promise<boolean> {
  const allowed = !/^rm/.test(call.toolName);
  log("guard", `${call.id} ${call.toolName} → ${allowed ? "allowed" : "blocked"}`);
  return allowed;
}

/** "Notifies" the approver: prints the command that resolves this approval. */
export async function notifyApprover(call: ToolCall): Promise<void> {
  log("approver", `${call.id} ${call.toolName} is waiting for a human. Approve it with:`);
  log(
    "approver",
    `  curl localhost:8080/finale/approve --json '{"invocationId": "<id from /send>", "callId": "${call.id}", "decision": "approved"}'`,
  );
}
