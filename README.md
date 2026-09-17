# A durable agent loop in six snippets

Companion code for the blog post: an agent loop is just a `while (true)` around a
model call, and by expressing each side effect as a journaled durable step, the same
plain loop picks up concurrency, background work, event-driven wake-ups, live steering
and week-long human approvals without ever changing shape.

Built on Restate's generator SDK, [`@restatedev/restate-sdk-gen`](https://www.npmjs.com/package/@restatedev/restate-sdk-gen).

## The ladder

Each file is one stage and is fully self-contained: the types, the turn, the Restate
endpoint and the demo mocks (a scripted model, fake tools) all live in that one file.
Run any of them on its own.

| File | Stage | What changes |
| --- | --- | --- |
| `src/turn01.ts` | the durable loop | model → tools → repeat; every side effect is a journaled `run`, the batch is concurrent via `all` |
| `src/turn02.ts` | a guardrail, and why `spawn` exists | guard → tool is a two-step pipeline per call; `spawn` keeps calls parallel and steps sequenced |
| `src/turn03.ts` | name the pipeline | the spawned body becomes `performCall`; no `gen()` wrapper needed |
| `src/turn04.ts` | background tool calls | a `background` call is spawned, acked, and appends its own result later |
| `src/turn05.ts` | the fully task-based loop | every call is a task in a map; `select` wakes the model on the next completion |
| `src/turn06.ts` | steering, raced in the same select | a durable `steer` signal joins the one `select`, so notes and completions are ordered |
| `src/humanApproval.ts` | finale: a person inside a tool call | `humanApproval` drops into `performCall`; the `turn06` loop is unchanged |

## Run a stage

Prerequisites: Node.js 22+ and a Restate server.

```bash
npm install

# 1. a Restate server, in a second terminal (pick one)
npx @restatedev/restate-server
# docker run --rm -p 8080:8080 -p 9070:9070 --add-host=host.docker.internal:host-gateway docker.restate.dev/restatedev/restate:latest

# 2. one stage — they all listen on :9080 as service `TinyAgent`, so run one at a time
npm run turn01

# 3. register the endpoint (repeat with --force whenever you switch stages)
npx @restatedev/restate deployments register --force http://localhost:9080
# with the Docker server, register http://host.docker.internal:9080 instead

# 4. invoke the turn
curl localhost:8080/TinyAgent/turn01 --json '"ship the new build"'
```

Watch the terminal running the stage: the mocks log every model decision, guard
verdict and tool run with a timestamp, so the interleavings are visible. `turn01`
returns after about three seconds (the deploy), not the sum of the tool durations.

## Steering a running turn (turn06, finale)

The turn is addressed by its invocation id, which the `/send` call returns. The
`steer` handler in the same file is the send side.

```bash
ID=$(curl -s localhost:8080/TinyAgent/turn06/send --json '"ship the new build"' | jq -r .invocationId)
sleep 1
curl localhost:8080/TinyAgent/steer --json "{\"invocationId\": \"$ID\", \"note\": \"please also run the linter\"}"

# wait for and print the final answer
curl localhost:8080/restate/invocation/$ID/attach
```

The note arrives while the loop is parked on the select with the deploy and the test
still in flight. Nothing has completed, yet the model wakes immediately, reads the
note and starts a linter while the deploy is still running.

## Approving a tool call (finale)

In `src/humanApproval.ts` every deploy waits for a person. The stage log names the
waiting call; in the scripted scenario the deploy is always `call-3`.

```bash
ID=$(curl -s localhost:8080/TinyAgent/turn06/send --json '"ship the new build"' | jq -r .invocationId)
# take your time — the turn is suspended, no process is pinned
curl localhost:8080/TinyAgent/approve --json "{\"invocationId\": \"$ID\", \"callId\": \"call-3\", \"decision\": \"approved\"}"
curl localhost:8080/restate/invocation/$ID/attach
```

Any other decision string denies the call, and the model reads the denial as a plain
tool result.

## Using a real model

`src/llm-openai.ts` is `llm` implemented on the OpenAI chat completions API: the same
transcript in, the same `StepResult` out, still one journaled `run`. To use it in a
stage, delete that stage's mock `callModel` and import the real one:

```ts
import {callModel} from "./llm-openai.js";
```

It needs `OPENAI_API_KEY`; `OPENAI_MODEL` overrides the default model. Tool calls are
function calls, a plain-text reply is the final answer, and the single word `WAIT`
means "nothing new to ask, keep waiting". Results that land later than the call they
answer (background tasks, select wake-ups) are reported to the model as user messages,
because the API only accepts a tool message directly after its tool call.

## The scripted scenario

The mock model follows one plan so the interesting interleavings actually happen:

| Tool | Duration | Notes |
| --- | --- | --- |
| `search` | instant | |
| `rm_rf` | instant | blocked by the guardrail from turn02 onwards |
| `deploy` | 3s | background in turn04; needs approval in the finale |
| `test` | 5s | started while the deploy is still out |
| `lint` | instant | only when a steering note mentions the linter |

The model finishes as soon as every call it issued has a real result.

## Scripts

| Command | |
| --- | --- |
| `npm run turnNN` / `npm run humanApproval` | start one stage on port 9080 |
| `npm run typecheck` | `tsc --noEmit` over all stages |
| `npm run build` | compile to `dist/` |
