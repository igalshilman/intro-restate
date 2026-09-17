/**
 * turn03 — name the pipeline.
 *
 * Durable pipelines are just functions — they compose. Behaviour is identical
 * to turn02; the spawned body moved into a named `function*`, `performCall`.
 * Invoking a named `function*` already yields an `Operation`, so
 * `spawn(performCall(...))` needs no `gen()` wrapper.
 *
 * `performCall` is the seam the finale exploits: the human-approval gate
 * slots into this function while every loop above stays byte-identical.
 *
 * Self-contained: types, the turn, the endpoint and the demo mocks all live
 * in this file.
 *
 *   npm run turn03
 *   restate deployments register --force http://localhost:9080
 *   curl localhost:8080/TinyAgent/turn03 --json '"ship the new build"'
 */

import * as restate from "@restatedev/restate-sdk-gen";
import {serve} from "@restatedev/restate-sdk";

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

function* turn03(userMessage: string): restate.Operation<string> {
  const sandbox = yield* connect();

  const messages: Message[] = [{role: "user", content: userMessage}];
  while (true) {
    const action = yield* llm(messages);
    if (action.type === "final") {
      return action.message;
    }
    messages.push({role: "assistant", calls: action.calls});

    const tasks = action.calls.map((call) =>
      restate.spawn(performCall(call, sandbox)),
    );
    const results = yield* restate.all(tasks);
    messages.push({role: "tool", results});
  }
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

const TinyAgent = restate.service({
  name: "TinyAgent",
  handlers: {turn03},
});

serve({services: [TinyAgent], port: 9080});

// ===========================================================================
// Demo mocks — off-stage. A scripted "model" and fake tools, so that the
// interleavings the loop above is built for actually happen when you run it.
// Nothing below is part of the story.
// ===========================================================================

/**
 * The scripted model. It reads the transcript and follows one fixed plan:
 *
 *   1. opening batch: search (instant), rm_rf (blocked by the guard), deploy (3s)
 *   2. deploy still out and no test started yet: start test (5s)
 *   3. a steering note that mentions the linter: run lint (instant)
 *   4. anything still pending: nothing new to ask — keep waiting
 *   5. every result in: summarize and finish
 */
async function callModel(messages: Message[]): Promise<StepResult> {
  const isAck = (r: ToolResult) =>
    r.result === "started in background" || r.result === "task created";

  const issued = messages.flatMap((m) => (m.role === "assistant" ? m.calls : []));
  const results = messages.flatMap((m) => (m.role === "tool" ? m.results : []));
  const settled = new Set(results.filter((r) => !isAck(r)).map((r) => r.id));
  const pending = issued.filter((c) => !settled.has(c.id));
  const notes = messages.flatMap((m) => (m.role === "user" ? [m.content] : [])).slice(1);

  const issuedTool = (name: string) => issued.some((c) => c.toolName === name);
  const pendingTool = (name: string) => pending.some((c) => c.toolName === name);
  let seq = issued.length;
  const call = (
    toolName: string,
    args: Record<string, unknown>,
    background?: boolean,
  ): ToolCall => ({id: `call-${++seq}`, toolName, args, ...(background ? {background} : {})});

  let step: StepResult;
  if (issued.length === 0) {
    step = {
      type: "tool_calls",
      calls: [
        call("search", {query: "how do we ship?"}),
        call("rm_rf", {path: "/"}),
        call("deploy", {env: "staging"}),
      ],
    };
  } else if (notes.some((n) => /lint/i.test(n)) && !issuedTool("lint")) {
    step = {type: "tool_calls", calls: [call("lint", {})]};
  } else if (pendingTool("deploy") && !issuedTool("test")) {
    step = {type: "tool_calls", calls: [call("test", {suite: "e2e"})]};
  } else if (pending.length > 0) {
    step = {type: "tool_calls", calls: []};
  } else {
    const toolName = new Map(issued.map((c) => [c.id, c.toolName]));
    const summary = results
      .filter((r) => !isAck(r))
      .map((r) => `${toolName.get(r.id)}: ${r.result}`)
      .join("; ");
    step = {type: "final", message: `all done — ${summary}`};
  }

  log("model", `${pending.length} pending → ${describe(step)}`);
  return step;
}

function describe(step: StepResult): string {
  if (step.type === "final") return `final: "${step.message}"`;
  if (step.calls.length === 0) return "nothing new to ask, keep waiting";
  return (
    "calls " +
    step.calls
      .map((c) => `${c.id}=${c.toolName}${c.background ? " (background)" : ""}`)
      .join(", ")
  );
}

/** Fake sandbox provisioning: returns a plain, journal-friendly reference. */
async function provisionSandbox(): Promise<SandboxRef> {
  const id = `sbx-${crypto.randomUUID().slice(0, 8)}`;
  log("sandbox", `provisioned ${id}`);
  return {id, url: `https://sandbox.example.com/${id}`};
}

/** Fake tools: deploy takes 3s, test takes 5s, everything else is instant. */
async function runTool(call: ToolCall, sandbox: SandboxRef): Promise<string> {
  const ms = call.toolName === "deploy" ? 3_000 : call.toolName === "test" ? 5_000 : 0;
  log("tool", `${call.id} ${call.toolName} running in ${sandbox.id}${ms ? ` (${ms / 1000}s)` : ""}`);
  await new Promise((resolve) => setTimeout(resolve, ms));
  log("tool", `${call.id} ${call.toolName} done`);
  return `${call.toolName} ok`;
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
