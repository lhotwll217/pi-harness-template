---
title: "Web app"
summary: "The generic web chat app in apps/web: npm start, the server-held Gateway token, local-origin checks, and what the first cut leaves out"
read_when:
  - Starting the web app or changing how npm start launches it
  - Changing how the app reaches the daemon, or what it accepts from the browser
  - Building a product app from the template's app
---

# Web app

> **Status:** Implemented in `apps/web`. Its chat and workspace-file routes call
> the Gateway routes of [porting](porting.md) row 21; until those land, the page
> loads and reports the daemon's state but lists no chats or files.

The template ships an **App** (see [`CONTEXT.md`](../CONTEXT.md)): a browser
page with a chat list, a streaming chat, a files sidebar that updates live, and
a file editor. It is an external consumer of the Gateway like any other. It
lives in `apps/web`, outside the harness core
([Architecture](architecture.md#harness-core-exclusions)), and holds no harness
behavior: every action is one Gateway call.

It is cut from Stitcher's `apps/web` (`d55847f`): Next.js 16, the AI SDK's
`useChat`, AI Elements, and shadcn components. Stitcher's language-learning
parts stay in Stitcher. The licenses of the AI Elements, shadcn/ui, and Create
Next App code it carries are in `apps/web/THIRD_PARTY_NOTICES`.

## Start it

```bash
npm start
```

`scripts/start.mjs` runs `./pi-template status`, which starts the daemon when
none is running, then starts the app's dev server on `127.0.0.1` and waits until
the app reports the daemon ready. It prints one line on stdout:

```text
pi-template: app ready at http://127.0.0.1:47812
```

npm prints its own banner on stdout above that line, so a script reads the last
stdout line, or runs `npm start --silent` or `node scripts/start.mjs`, which
print only the ready line.

The web server's own output goes to stderr. The launcher sets
`NEXT_TELEMETRY_DISABLED=1` for the dev server, so a start sends Next.js no
usage data.

- `PI_TEMPLATE_WEB_PORT` sets the port (default `47812`, beside the daemon's
  `47811`). `0` picks a free loopback port, as `PI_TEMPLATE_PORT=0` does for the
  daemon.
- An app already answering on the port is reused when it serves the same
  harness home (`PI_TEMPLATE_HOME`). An app serving another home, or anything
  else on the port, stops the launch with a message naming the port.
- An un-onboarded home stops the launch with "run `./pi-template onboard`, then
  `npm start` again".
- Ctrl-C, a closed terminal, or a reader that closes stdout
  (`npm start | head -n1`) stops the web server this launch started; a second
  Ctrl-C kills it at once. The daemon keeps running; `./pi-template` owns it.

## How the browser reaches the harness

The app's Next.js route handlers are a backend-for-frontend. They are the only
holder of the Gateway token:

- Every handler reads `daemon.json` from the harness home on each request
  (`apps/web/src/lib/gateway-client.server.ts`), so a restarted daemon with a
  new port or token needs no app restart.
- The browser never receives the token: no cookie, no injected script, no
  proxy rewrite.
- The Gateway is unchanged: token only, no CORS.

| App route | Gateway route |
|---|---|
| `GET /api/status` | `GET /ready`, answered as `{ daemon: "ready" \| "setup" \| "down", home }`, where `home` is the harness home the app serves |
| `GET /api/chats` | `GET /chats` |
| `GET`, `PATCH`, `DELETE /api/chats/:id` | the same `/chats/:id` route; a chat id the Gateway has not stored opens empty |
| `POST /api/chats/:id/messages` | `POST /chats/:id/messages`; the NDJSON reply is re-encoded as the AI SDK UI message stream |
| `POST /api/chats/:id/cancel` | `POST /chats/:id/cancel` |
| `GET /api/events` | `GET /events`, piped as is |
| `GET`, `PUT /api/workspace/file?path=` | the same route; a stale save answers 409 with the file on disk |
| `GET /api/workspace/tree` | `GET /workspace/tree` |

A Gateway refusal reaches the page as one sentence
(`ownerMessage` in `apps/web/src/lib/gateway-error.ts`) with the Gateway's
status: `daemon_stopping` says to send again once the daemon restarts;
`too_large`, `filesystem_error`, `invalid_path`, and a refused chat title lead
with what failed and add the Gateway's reason when it is short enough to read.
Other refusals, such as `chat_busy`, show the Gateway's own text.

When the daemon is unreachable, `/api/events` answers one `event: daemon`
frame and closes, so the browser keeps reconnecting and the page shows "The
harness is unreachable" until the daemon is back.

## Local-origin checks

Next binds `127.0.0.1` only. Every handler first runs `assertLocalRequest`
(`apps/web/src/lib/local-request.ts`):

- a `Host` other than `127.0.0.1` or `localhost` is refused (DNS rebinding);
- `sec-fetch-site: cross-site` is refused;
- an `Origin` other than the app's own is refused;
- a mutation with a body must be `application/json` (415 otherwise), which no
  cross-site form can send without a preflight the app never answers.

## What the page does

- **Chats.** New chat mints its id in the browser; the Gateway stores the chat
  with its first message. Switching, renaming, and deleting update the list from
  the route's answer, without a reload. A reply streams into the thread, tool
  calls fold into a collapsible group, and Stop cancels the turn.
- **Live updates.** The page opens one `EventSource`. `chat.changed` refetches
  the chat list and, for the open chat, its messages, unless this page is
  streaming that chat's reply. `workspace.changed` and `schedule-run.changed`
  refetch the files tree and the open file. Window focus refetches everything,
  which covers edits the Gateway does not announce.
- **Files.** The sidebar lists the workspace tree; New file writes an empty
  `Untitled.md`. The editor autosaves 750 ms after typing stops and on blur,
  with the revision it was based on; a file changed on disk meanwhile shows
  Keep mine, Keep disk, and Keep both.

## Not in the first cut

Image attachments, file chips in the composer, folder create, move, and trash,
editing `AGENTS.md`, and an artifact pane. No Gateway route serves them yet.

## Tests

`npm --prefix apps/web test` runs the app's Vitest suite; root `npm test` runs
it too. Route and component tests run the real route handlers against a loopback
fake Gateway faithful to the row-21 route contracts
(`apps/web/src/test/fake-gateway.ts`). `test/start.integration.test.ts` runs
`scripts/start.mjs` against stand-ins for `pi-template` and the dev server.
