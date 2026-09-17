# A durable agent loop in six snippets

Companion code for the blog post: an agent loop is just a `while (true)` around a
model call, and by expressing each side effect as a journaled durable step, the same
plain loop picks up concurrency, background work, event-driven wake-ups, live steering
and week-long human approvals without ever changing shape.

Built on Restate's generator SDK, [`@restatedev/restate-sdk-gen`](https://www.npmjs.com/package/@restatedev/restate-sdk-gen).

## The ladder

One file per stage. Each holds the turn, its tool pipeline and the fake tools. The
model is real (`src/llm-openai.ts`, OpenAI chat completions), the types are shared
(`src/types.ts`), and `src/app.ts` serves every stage as its own Restate service.

| File | Service | Stage | What changes |
| --- | --- | --- | --- |
| `src/step01.ts` | `step01` | the durable loop | model → tools → repeat; every side effect is a journaled `run`, the batch is concurrent via `all` |
| `src/step02.ts` | `step02` | a guardrail, and why `spawn` exists | guard → tool is a two-step pipeline per call; `spawn` keeps calls parallel and steps sequenced |
| `src/step03.ts` | `step03` | name the pipeline | the spawned body becomes `performCall`; no `gen()` wrapper needed |
| `src/step04.ts` | `step04` | background tool calls | a `background` call is spawned, acked, and appends its own result later |
| `src/step05.ts` | `step05` | the fully task-based loop | every call is a task in a map; `select` wakes the model on the next completion |
| `src/step06.ts` | `step06` | steering, raced in the same select | a durable `steer` signal joins the one `select`, so notes and completions are ordered |
| `src/finale.ts` | `finale` | a person inside a tool call | `humanApproval` drops into `performCall`; the step06 loop is unchanged |

## Run

Prerequisites: Node.js 22+, a Restate server, and an OpenAI API key.

```bash
npm install
export OPENAI_API_KEY=sk-...        # OPENAI_MODEL overrides the default (gpt-5-mini)

# a Restate server, in a second terminal (pick one)
npx @restatedev/restate-server
# docker run --rm -p 8080:8080 -p 9070:9070 --add-host=host.docker.internal:host-gateway docker.restate.dev/restatedev/restate:latest

# every step, one endpoint on :9080
npm run dev

# register once (with the Docker server, register http://host.docker.internal:9080 instead)
npx @restatedev/restate deployments register http://localhost:9080

# invoke a step
curl localhost:8080/step01/run --json '"Ship the new build: find out how we deploy, deploy it to staging, run the e2e test suite, and delete /tmp/old-builds."'
```

Every service has a `run` handler that takes the user message. Watch the terminal
running `npm run dev`: every model decision, guard verdict and tool run is logged with a
timestamp, so the interleavings are visible.

## Steering a running turn (step06, finale)

The turn is addressed by its invocation id, which `/send` returns. The `steer` handler
on the same service is the send side.

```bash
ID=$(curl -s localhost:8080/step06/run/send --json '"Ship the new build: find out how we deploy, deploy it to staging, run the e2e test suite, and delete /tmp/old-builds."' | jq -r .invocationId)
curl localhost:8080/step06/steer --json "{\"invocationId\": \"$ID\", \"note\": \"please also run the linter\"}"

# wait for and print the final answer
curl localhost:8080/restate/invocation/$ID/attach
```

## Approving a tool call (finale)

In `finale` every deploy waits for a person. The log prints the approve command with
the waiting call's id; fill in the invocation id from `/send`.

```bash
ID=$(curl -s localhost:8080/finale/run/send --json '"Ship the new build: find out how we deploy, deploy it to staging, run the e2e test suite, and delete /tmp/old-builds."' | jq -r .invocationId)
# take your time — the turn is suspended, no process is pinned
curl localhost:8080/finale/approve --json "{\"invocationId\": \"$ID\", \"callId\": \"<call id from the log>\", \"decision\": \"approved\"}"
curl localhost:8080/restate/invocation/$ID/attach
```

Any other decision string denies the call, and the model reads the denial as a plain
tool result.

## The model

`src/llm-openai.ts` is `llm` on the OpenAI chat completions API: the transcript in, a
`StepResult` out, still one journaled `run`. Every step imports its `callModel`.

Tool calls are function calls; a `background: true` argument marks a call the loop
should not await within the step (step04). A plain-text reply is the final answer. The
single word `WAIT` means "nothing new to ask, keep waiting" (step05+); a `WAIT` when
nothing is pending is answered with a nudge to finish, because the task-based loops
would otherwise park for good. Results that land later than the call they answer
(background tasks, select wake-ups) are reported to the model as user messages, since
the API only accepts a tool message directly after its tool call.

## The fake tools

| Tool | Duration | Notes |
| --- | --- | --- |
| `search` | instant | answers with a pointer to the other tools |
| `rm_rf` | instant | blocked by the guardrail from step02 onwards |
| `deploy` | 3s | needs approval in the finale |
| `test` | 5s | |
| `lint` | instant | |

## Scripts

| Command | |
| --- | --- |
| `npm run dev` | serve every step on port 9080, restarting on file changes |
| `npm start` | same, without the file watcher |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | compile to `dist/` |
