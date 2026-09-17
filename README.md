# A durable agent loop in six snippets

Companion code for the blog post: an agent loop is just a `while (true)` around a
model call, and by expressing each side effect as a journaled durable step, the same
plain loop picks up concurrency, background work, event-driven wake-ups, live steering
and week-long human approvals without ever changing shape.

Built on Restate's generator SDK, [`@restatedev/restate-sdk-gen`](https://www.npmjs.com/package/@restatedev/restate-sdk-gen).

## The ladder

Each file is one stage: the types, the turn, the Restate endpoint and the fake tools
live in that file. The model is real — `src/llm-openai.ts`, on the OpenAI chat
completions API. Run any stage on its own.

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

Prerequisites: Node.js 22+, a Restate server, and an OpenAI API key.

```bash
npm install
export OPENAI_API_KEY=sk-...        # OPENAI_MODEL overrides the default (gpt-5-mini)

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

Watch the terminal running the stage: every model decision, guard verdict and tool
run is logged with a timestamp, so the interleavings are visible. In `turn01` the
tool batch takes about three seconds (the deploy), not the sum of the tool durations.

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

In `src/humanApproval.ts` every deploy waits for a person. The stage log prints the
approve command with the waiting call's id; fill in the invocation id from `/send`.

```bash
ID=$(curl -s localhost:8080/TinyAgent/turn06/send --json '"ship the new build"' | jq -r .invocationId)
# take your time — the turn is suspended, no process is pinned
curl localhost:8080/TinyAgent/approve --json "{\"invocationId\": \"$ID\", \"callId\": \"<call id from the log>\", \"decision\": \"approved\"}"
curl localhost:8080/restate/invocation/$ID/attach
```

Any other decision string denies the call, and the model reads the denial as a plain
tool result.

## The model

`src/llm-openai.ts` is `llm` on the OpenAI chat completions API: the transcript in, a
`StepResult` out, still one journaled `run`. Every stage imports its `callModel`.

Tool calls are function calls; a `background: true` argument marks a call the loop
should not await within the step (turn04). A plain-text reply is the final answer. The
single word `WAIT` means "nothing new to ask, keep waiting" (turn05+); a `WAIT` when
nothing is pending is answered with a nudge to finish, because the task-based loops
would otherwise park for good. Results that land later than the call they answer
(background tasks, select wake-ups) are reported to the model as user messages, since
the API only accepts a tool message directly after its tool call.

## The fake tools

| Tool | Duration | Notes |
| --- | --- | --- |
| `search` | instant | answers with a pointer to the other tools |
| `rm_rf` | instant | blocked by the guardrail from turn02 onwards |
| `deploy` | 3s | needs approval in the finale |
| `test` | 5s | |
| `lint` | instant | |

## Scripts

| Command | |
| --- | --- |
| `npm run turnNN` / `npm run humanApproval` | start one stage on port 9080 |
| `npm run typecheck` | `tsc --noEmit` over all stages |
| `npm run build` | compile to `dist/` |
