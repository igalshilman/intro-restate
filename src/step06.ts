// step06 — steering, raced in the same select
//
//   npm run dev                                          # serves step01..step06 and finale on :9080
//   restate deployments register http://localhost:9080
//   ID=$(curl -s localhost:8080/step06/run/send --json '"Ship the new build: find out how we deploy, deploy it to staging, run the e2e test suite, and delete /tmp/old-builds."' | jq -r .invocationId)
//   curl localhost:8080/step06/steer --json "{\"invocationId\": \"$ID\", \"note\": \"please also run the linter\"}"
//   curl localhost:8080/restate/invocation/$ID/attach

import * as restate from "@restatedev/restate-sdk-gen";
import {callModel} from "./llm-openai.js";
import type {ToolCall, StepResult, ToolResult, Message, SandboxRef} from "./types.js";

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

/** One tool call as a durable pipeline: journaled guard verdict first, then
 * the tool only if allowed. A blocked call is just a structured result. */
function* performCall(
  call: ToolCall,
  sandbox: SandboxRef,
): restate.Operation<ToolResult> {
  const allowed = yield* restate.run(async () => evaluateGuard(call), {
    name: "guard",
  });
  if (!allowed) {
    return {id: call.id, result: "blocked by guardrail"};
  }

  const result = yield* restate.run(async () => runTool(call, sandbox), {
    name: "tool",
  });
  return {id: call.id, result};
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

function* turn06(userMessage: string): restate.Operation<string> {
  const sandbox = yield* connect();

  /** Everything in flight, keyed by call id. */
  const tasks = new Map<string, restate.Future<ToolResult>>();
  /** The next steering note; re-armed after each delivery. */
  let steer = restate.signal<string>("steer");

  const messages: Message[] = [{role: "user", content: userMessage}];
  while (true) {
    const action = yield* llm(messages);
    if (action.type === "final") {
      return action.message;
    }
    messages.push({role: "assistant", calls: action.calls});

    for (const call of action.calls) {
      tasks.set(call.id, restate.spawn(performCall(call, sandbox)));
    }
    messages.push({
      role: "tool",
      results: action.calls.map(({id}) => ({id, result: "task created"})),
    });

    // the steer races the tasks in ONE select — notes and completions
    // land in a single deterministic order, and either wakes the model.
    const next = yield* restate.select({...Object.fromEntries(tasks), steer});
    if (next.tag === "steer") {
      messages.push({role: "user", content: yield* steer});
      steer = restate.signal<string>("steer"); // arm the next note
    } else {
      // a task completed — its tag is the call id
      const result = yield* tasks.get(next.tag)!;
      tasks.delete(next.tag);
      messages.push({role: "tool", results: [result]});
    }
  }
}

// ---------------------------------------------------------------------------
// Send side — from anywhere outside the turn, addressed by its invocation id
// ---------------------------------------------------------------------------

/** Steer a running turn. The id is the turn's invocation id (constant across
 * retries and suspensions), so it's a stable address for a running turn. */
function* steer({
  invocationId,
  note,
}: {
  invocationId: string;
  note: string;
}): restate.Operation<void> {
  restate.invocation(invocationId).signal<string>("steer").resolve(note);
}

// ---------------------------------------------------------------------------
// The service — served together with the other steps by app.ts
// ---------------------------------------------------------------------------

export const step06 = restate.service({
  name: "step06",
  handlers: {run: turn06, steer},
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
