/**
 * turn04 — background tool calls.
 *
 * A step no longer has to wait for everything it started. A call the model
 * marks `background` is spawned but not awaited within the step: it keeps
 * running while the loop moves on and appends its own result to the
 * transcript when it lands — often a step or two later. The model gets an
 * immediate "started in background" ack.
 *
 * The spawned closure captures `messages` and pushes into it. Generator
 * concurrency is cooperative — one logical thread, interleaving only at
 * yield points — so this is safe without a lock.
 *
 * Stated simplification: we trust the model not to say "final" while
 * background work is still running.
 *
 * The model is real — `llm-openai.ts`, needs OPENAI_API_KEY. The turn, the
 * endpoint and the fake tools live in this file.
 *
 *   npm run turn04
 *   restate deployments register --force http://localhost:9080
 *   curl localhost:8080/TinyAgent/turn04 --json '"ship the new build"'
 */

import * as restate from "@restatedev/restate-sdk-gen";
import {gen} from "@restatedev/restate-sdk-gen";
import {serve} from "@restatedev/restate-sdk";
import {callModel} from "./llm-openai.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What the model can ask for. `background` marks a call the loop should
 * not await within the step (turn04). */
type ToolCall = {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  background?: boolean;
};

/** One model step either finishes the turn or proposes a batch of tools. */
type StepResult =
  | {type: "final"; message: string}
  | {type: "tool_calls"; calls: ToolCall[]};

/** A tool result is keyed by its call id — that's how the model matches it. */
type ToolResult = {id: string; result: string};

/** The conversation transcript: every interaction is a typed entry. */
type Message =
  | {role: "user"; content: string}
  | {role: "assistant"; calls: ToolCall[]}
  | {role: "tool"; results: ToolResult[]};

/** A serializable sandbox reference — what gets journaled is this plain
 * data, never a live connection. */
type SandboxRef = {id: string; url: string};

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

function* turn04(userMessage: string): restate.Operation<string> {
  const sandbox = yield* connect();

  const messages: Message[] = [{role: "user", content: userMessage}];
  while (true) {
    const action = yield* llm(messages);
    if (action.type === "final") {
      return action.message;
    }
    messages.push({role: "assistant", calls: action.calls});

    const acks: ToolResult[] = [];
    const tasks: restate.Task<ToolResult>[] = [];
    for (const call of action.calls) {
      if (!call.background) {
        tasks.push(restate.spawn(performCall(call, sandbox)));
        continue;
      }
      // Spawned but NOT awaited this step: the task keeps running while
      // the loop moves on, and appends its own result — possibly during
      // a later step — for the model's next look.
      restate.spawn(
        gen(function* () {
          const result = yield* performCall(call, sandbox);
          messages.push({role: "tool", results: [result]});
        }),
      );
      acks.push({id: call.id, result: "started in background"});
    }
    const results = yield* restate.all(tasks);
    messages.push({role: "tool", results: [...acks, ...results]});
  }
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

const TinyAgent = restate.service({
  name: "TinyAgent",
  handlers: {turn04},
});

serve({services: [TinyAgent], port: 9080});

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
