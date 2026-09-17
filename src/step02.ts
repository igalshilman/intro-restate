// step02 — a guardrail, and why `spawn` exists
//
//   npm run dev                                          # serves step01..step06 and finale on :9080
//   restate deployments register http://localhost:9080
//   curl localhost:8080/step02/run --json '"Ship the new build: find out how we deploy, deploy it to staging, run the e2e test suite, and delete /tmp/old-builds."'

import * as restate from "@restatedev/restate-sdk-gen";
import {gen} from "@restatedev/restate-sdk-gen";
import {callModel} from "./llm-openai.js";
import type {ToolCall, StepResult, Message, SandboxRef} from "./types.js";

// ---------------------------------------------------------------------------
// Durable building blocks
// ---------------------------------------------------------------------------

/** One model call over the conversation so far, journaled: on replay the
 * same answer comes back for free. */
function* llm(messages: Message[]): restate.Operation<StepResult> {
  return yield* restate.run(async () => callModel(messages), {name: "model"});
}

/** Provisions a sandbox once per turn; replay returns the journaled ref. */
function* connect(): restate.Operation<SandboxRef> {
  return yield* restate.run(async () => provisionSandbox(), {name: "sandbox"});
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

function* turn02(userMessage: string): restate.Operation<string> {
  const sandbox = yield* connect();

  const messages: Message[] = [{role: "user", content: userMessage}];
  while (true) {
    const action = yield* llm(messages);
    if (action.type === "final") {
      return action.message;
    }
    messages.push({role: "assistant", calls: action.calls});

    const tasks = action.calls.map((call) =>
      restate.spawn(
        gen(function* () {
          //
          // first evaluate the guardrail, then run the tool if allowed
          //
          const allowed = yield* restate.run(async () => evaluateGuard(call), {
            name: "guard",
          });
          if (!allowed) {
            return {id: call.id, result: "blocked by guardrail"};
          }
          //
          // run the tool if allowed
          //
          const result = yield* restate.run(
            async () => runTool(call, sandbox),
            {name: "tool"},
          );
          //
          // return a structured result
          //
          return {id: call.id, result};
        }),
      ),
    );

    const results = yield* restate.all(tasks);
    messages.push({role: "tool", results});
  }
}

// ---------------------------------------------------------------------------
// The service — served together with the other steps by app.ts
// ---------------------------------------------------------------------------

export const step02 = restate.service({
  name: "step02",
  handlers: {run: turn02},
});

// ===========================================================================
// Fake tools — off-stage. The model is real (llm-openai.ts); the tools are
// stand-ins with durations chosen so the interleavings above actually happen.
// Nothing below is part of the story.
// ===========================================================================

/** Fake sandbox provisioning: returns a plain, journal-friendly reference. */
async function provisionSandbox(): Promise<SandboxRef> {
  const id = `sbx-${crypto.randomUUID().slice(0, 8)}`;
  log("sandbox", `provisioned ${id}`);
  return {id, url: `https://sandbox.example.com/${id}`};
}

/** Fake tools: deploy takes 3s, test takes 5s, everything else is instant.
 * `search` answers with a pointer to the other tools, so a real model knows
 * what to do next instead of searching again. */
async function runTool(call: ToolCall, sandbox: SandboxRef): Promise<string> {
  const ms = call.toolName === "deploy" ? 3_000 : call.toolName === "test" ? 5_000 : 0;
  log("tool", `${call.id} ${call.toolName} running in ${sandbox.id}${ms ? ` (${ms / 1000}s)` : ""}`);
  await new Promise((resolve) => setTimeout(resolve, ms));
  log("tool", `${call.id} ${call.toolName} done`);
  return call.toolName === "search"
    ? "found: deploy with the deploy tool (env: staging), run the e2e suite with the test tool, lint with the lint tool"
    : `${call.toolName} ok`;
}

/** The guardrail: anything rm-shaped is blocked. */
async function evaluateGuard(call: ToolCall): Promise<boolean> {
  const allowed = !/^rm/.test(call.toolName);
  log("guard", `${call.id} ${call.toolName} → ${allowed ? "allowed" : "blocked"}`);
  return allowed;
}

function log(who: string, message: string): void {
  console.log(`${new Date().toISOString().slice(11, 23)} [${who}] ${message}`);
}
