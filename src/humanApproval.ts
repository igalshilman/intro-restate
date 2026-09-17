/**
 * finale — humanApproval: zoom into one tool call.
 *
 * A human-in-the-loop gate is two lines: a journaled notify step, then a
 * park on a signal named after the call id. Waiting is free: if the human
 * takes three days, the turn suspends — nothing polls, nothing times out, no
 * process is pinned — and the journal resumes the moment the decision lands.
 *
 * The loop never changes. `humanApproval` is dropped into `performCall` in
 * front of the tool run, and `turn06` below is byte-for-byte the one in
 * turn06.ts. The batch keeps running, steering keeps working, the model
 * keeps getting woken by other completions — one task is simply parked on a
 * person.
 *
 * Self-contained: types, the turn, the endpoint and the demo mocks all live
 * in this file. `steer` and `approve` are the send side.
 *
 *   npm run humanApproval
 *   restate deployments register --force http://localhost:9080
 *   ID=$(curl -s localhost:8080/TinyAgent/turn06/send --json '"ship the new build"' | jq -r .invocationId)
 *   # the service log names the waiting call (the deploy, call-3); decide whenever you like:
 *   curl localhost:8080/TinyAgent/approve --json "{\"invocationId\": \"$ID\", \"callId\": \"call-3\", \"decision\": \"approved\"}"
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

/** A human-in-the-loop gate in two lines: a journaled notify step, then a
 * park on a signal named after the call id — so any number of approvals can
 * be pending at once and the approver resolves exactly the one they mean.
 * If the human takes three days, the turn suspends: nothing polls, nothing
 * times out, no process is pinned. */
function* humanApproval(call: ToolCall): restate.Operation<string> {
  yield* restate.run(async () => notifyApprover(call), {name: "notify"});
  return yield* restate.signal<string>(`approval-${call.id}`);
}

/** The same pipeline as turn03..06, with `humanApproval` dropped in front of
 * the tool run. The loop below does not change. */
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

  // deploys need a person: park this one task until the decision lands
  if (call.toolName === "deploy") {
    const decision = yield* humanApproval(call);
    if (decision !== "approved") {
      return {id: call.id, result: `denied by human: ${decision}`};
    }
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

/** Approve or deny one pending tool call of a running turn. Same one-liner as
 * steering; the signal name carries the call id. */
function* approve({
  invocationId,
  callId,
  decision,
}: {
  invocationId: string;
  callId: string;
  decision: string;
}): restate.Operation<void> {
  restate
    .invocation(invocationId)
    .signal<string>(`approval-${callId}`)
    .resolve(decision);
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

const TinyAgent = restate.service({
  name: "TinyAgent",
  handlers: {turn06, steer, approve},
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

/** "Notifies" the approver: prints the command that resolves this approval. */
async function notifyApprover(call: ToolCall): Promise<void> {
  log("approver", `${call.id} ${call.toolName} is waiting for a human. Approve it with:`);
  log(
    "approver",
    `  curl localhost:8080/TinyAgent/approve --json '{"invocationId": "<id from /send>", "callId": "${call.id}", "decision": "approved"}'`,
  );
}

function log(who: string, message: string): void {
  console.log(`${new Date().toISOString().slice(11, 23)} [${who}] ${message}`);
}
