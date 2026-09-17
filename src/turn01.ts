/**
 * turn01 — the durable loop.
 *
 * An agent turn is a plain `while (true)` around a model call: model, tools,
 * repeat. It becomes durable because every side effect is a journaled `run`.
 * Crash at step 7 and replay returns steps 1–6 from the journal — no LLM
 * re-billed, no tool re-run — then the loop resumes exactly where it was.
 *
 * `connect()` journals a serializable sandbox reference once at the top of
 * the turn; on replay the turn reattaches to the same sandbox. The tool batch
 * is already concurrent: `map` creates the `run` futures, `all` awaits them
 * together. A 3s deploy plus two instant calls takes ~3s, not the sum.
 *
 * The model is real — `llm-openai.ts`, needs OPENAI_API_KEY. The turn, the
 * endpoint and the fake tools live in this file.
 *
 *   npm run turn01
 *   restate deployments register --force http://localhost:9080
 *   curl localhost:8080/TinyAgent/turn01 --json '"ship the new build"'
 */

import * as restate from "@restatedev/restate-sdk-gen";
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

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

function* turn01(userMessage: string): restate.Operation<string> {
  const sandbox = yield* connect();

  const messages: Message[] = [{role: "user", content: userMessage}];
  while (true) {
    const action = yield* llm(messages);
    if (action.type === "final") {
      return action.message;
    }
    messages.push({role: "assistant", calls: action.calls});

    const futures = action.calls.map((call) =>
      restate.run(
        async () => ({id: call.id, result: await runTool(call, sandbox)}),
        {name: "tool"},
      ),
    );
    const results = yield* restate.all(futures);
    messages.push({role: "tool", results});
  }
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

const TinyAgent = restate.service({
  name: "TinyAgent",
  handlers: {turn01},
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

function log(who: string, message: string): void {
  console.log(`${new Date().toISOString().slice(11, 23)} [${who}] ${message}`);
}
