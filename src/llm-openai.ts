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
 *   - the single word WAIT means "nothing new to ask, keep waiting" (turn05+)
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

const SYSTEM = `You are a release engineer working inside a sandbox. Use the tools to do what the user asks.
Some tool results arrive later: "task created" and "started in background" are acknowledgements, the real result follows.
If you are waiting on pending results and have nothing new to request, reply with exactly WAIT.
When every result is in, reply with a short plain-text summary.`;

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
  if (calls.length > 0) return {type: "tool_calls", calls};

  const text = (reply.content ?? "").trim();
  if (/^WAIT\b/i.test(text)) return {type: "tool_calls", calls: []};
  return {type: "final", message: text};
}

/** Our transcript → OpenAI messages. */
function render(messages: Message[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{role: "system", content: SYSTEM}];
  let open = new Set<string>(); // calls of the latest assistant message not yet answered in-protocol
  for (const m of messages) {
    if (m.role === "user") {
      out.push({role: "user", content: m.content});
    } else if (m.role === "assistant") {
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
        else out.push({role: "user", content: `Result of ${r.id}: ${r.result}`});
      }
    }
  }
  return out;
}
