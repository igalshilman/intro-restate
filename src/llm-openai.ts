/**
 * llm — the real thing, on the OpenAI chat completions API.
 *
 * A drop-in for the scripted `callModel` in any stage: the same transcript in,
 * the same `StepResult` out, still one journaled `run`. Delete a stage's mock
 * `callModel` and `import {callModel} from "./llm-openai.js"` — or import `llm`
 * itself. Needs OPENAI_API_KEY; OPENAI_MODEL overrides the model.
 *
 * Wire protocol between the loop and the model:
 *   - tool calls are OpenAI function calls; a `background: true` argument marks
 *     a call the loop should not await within the step (turn04)
 *   - a plain-text reply is the final answer
 *   - the single word WAIT means "nothing new to ask, keep waiting" (turn05+);
 *     a WAIT when nothing is pending is answered with a nudge to finish
 *
 * OpenAI insists that a tool message answers the tool call right before it. A
 * result that lands later — a background task, a select wake-up — is therefore
 * reported to the model as a user message instead.
 */

import * as restate from "@restatedev/restate-sdk-gen";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

type ToolCall = {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  background?: boolean;
};
type StepResult =
  | {type: "final"; message: string}
  | {type: "tool_calls"; calls: ToolCall[]};
type ToolResult = {id: string; result: string};
type Message =
  | {role: "user"; content: string}
  | {role: "assistant"; calls: ToolCall[]}
  | {role: "tool"; results: ToolResult[]};

/** One model call over the conversation so far, journaled: on replay the
 * same answer comes back for free. */
export function* llm(messages: Message[]): restate.Operation<StepResult> {
  return yield* restate.run(async () => callModel(messages), {name: "model"});
}

const openai = new OpenAI();
const MODEL = process.env.OPENAI_MODEL ?? "gpt-5-mini";

const SYSTEM = `You are a release engineer working inside a sandbox. Use the tools to do what the user asks; you may request several at once.
Tool results can arrive later than the call: "task created" and "started in background" are acknowledgements only — the real result follows as a message "Result of <call id> (<tool>): ...".
Reply with exactly WAIT only while a call you made has no real result yet and you have nothing new to request.
Once every call has its real result, reply with a short plain-text summary — never WAIT.`;

const tool = (
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
): ChatCompletionTool => ({
  type: "function",
  function: {
    name,
    description,
    parameters: {
      type: "object",
      properties: {
        ...properties,
        background: {
          type: "boolean",
          description: "Start it and move on without waiting for the result in this step.",
        },
      },
    },
  },
});

const TOOLS = [
  tool("search", "Search the codebase and docs.", {query: {type: "string"}}),
  tool("rm_rf", "Recursively delete a path.", {path: {type: "string"}}),
  tool("deploy", "Deploy the current build to an environment. Slow.", {env: {type: "string"}}),
  tool("test", "Run a test suite. Slow.", {suite: {type: "string"}}),
  tool("lint", "Run the linter."),
];

export async function callModel(messages: Message[]): Promise<StepResult> {
  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages: render(messages),
    tools: TOOLS,
  });
  const reply = completion.choices[0]!.message;

  const calls: ToolCall[] = (reply.tool_calls ?? [])
    .filter((tc) => tc.type === "function")
    .map((tc) => {
      const {background, ...args} = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
      return {id: tc.id, toolName: tc.function.name, args, ...(background ? {background: true} : {})};
    });

  let step: StepResult;
  const text = (reply.content ?? "").trim();
  if (calls.length > 0) {
    step = {type: "tool_calls", calls};
  } else if (/^WAIT\b/i.test(text)) {
    // the task-based loops trust the model to finish exactly when nothing is
    // pending — a WAIT with an empty task list would park them for good, so
    // hold the model to it: point out that everything is in and ask again.
    if (pending(messages) === 0 && !messages.some((m) => m.role === "user" && m.content === NUDGE)) {
      return callModel([...messages, {role: "user", content: NUDGE}]);
    }
    step = {type: "tool_calls", calls: []};
  } else {
    step = {type: "final", message: text};
  }

  log(step);
  return step;
}

const NUDGE = "Every call has its real result; nothing is pending. Reply with your final summary.";
const ACKS = new Set(["task created", "started in background"]);

/** Calls the loop issued that have no real result in the transcript yet. */
function pending(messages: Message[]): number {
  const settled = new Set(
    messages
      .flatMap((m) => (m.role === "tool" ? m.results : []))
      .filter((r) => !ACKS.has(r.result))
      .map((r) => r.id),
  );
  return messages.flatMap((m) => (m.role === "assistant" ? m.calls : [])).filter((c) => !settled.has(c.id)).length;
}

function log(step: StepResult): void {
  const what =
    step.type === "final"
      ? `final: ${JSON.stringify(step.message.length > 80 ? step.message.slice(0, 80) + "…" : step.message)}`
      : step.calls.length === 0
        ? "WAIT"
        : "calls " + step.calls.map((c) => `${c.toolName}${c.background ? " (background)" : ""}`).join(", ");
  console.log(`${new Date().toISOString().slice(11, 23)} [model] ${what}`);
}

/** Our transcript → OpenAI messages. */
function render(messages: Message[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{role: "system", content: SYSTEM}];
  const toolName = new Map<string, string>();
  let open = new Set<string>(); // calls of the latest assistant message not yet answered in-protocol
  for (const m of messages) {
    if (m.role === "user") {
      out.push({role: "user", content: m.content});
    } else if (m.role === "assistant") {
      for (const c of m.calls) toolName.set(c.id, c.toolName);
      open = new Set(m.calls.map((c) => c.id));
      out.push(
        m.calls.length === 0
          ? {role: "assistant", content: "WAIT"}
          : {
              role: "assistant",
              tool_calls: m.calls.map((c) => ({
                id: c.id,
                type: "function",
                function: {name: c.toolName, arguments: JSON.stringify({...c.args, background: c.background})},
              })),
            },
      );
    } else {
      for (const r of m.results) {
        if (open.delete(r.id)) out.push({role: "tool", tool_call_id: r.id, content: r.result});
        else out.push({role: "user", content: `Result of ${r.id} (${toolName.get(r.id) ?? "tool"}): ${r.result}`});
      }
    }
  }
  return out;
}
