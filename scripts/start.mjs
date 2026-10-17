#!/usr/bin/env node
// stdout carries one line, `pi-template: app ready at http://127.0.0.1:<port>`, so a script or
// an agent can read the URL; the web server's own output goes to stderr. `npm start` adds npm's
// banner above it, so scripts run `npm start --silent` or `node scripts/start.mjs`, or read the
// last stdout line. Ctrl-C, SIGHUP, or a closed stdout stops only the web server this launch
// started. The daemon belongs to the CLI and keeps running.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_WEB_PORT = 47812;
const WEB_READY_TIMEOUT_MS = 120_000;
const POLL_MS = 200;

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

class LaunchError extends Error {}

const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

async function runCapture(command, args, options) {
  return await new Promise((done) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => done({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.once("exit", (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

async function startDaemonViaStatus(env) {
  const result = await runCapture(join(repositoryRoot, "pi-template"), ["status"], { cwd: repositoryRoot, env });
  let status;
  try {
    status = JSON.parse(result.stdout);
  } catch {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ");
    throw new LaunchError(`the daemon did not report its status${detail ? ` (${detail})` : ""}. Run \`./pi-template doctor\`.`);
  }
  if (status.ready?.setupRequired) {
    throw new LaunchError("setup is incomplete. Run `./pi-template onboard`, then `npm start` again.");
  }
  if (status.ready?.ready !== true) {
    const down = Object.entries(status.ready?.modules ?? {}).filter(([, up]) => !up).map(([name]) => name);
    throw new LaunchError(`the daemon is not ready (${down.join(", ") || "unknown module"}). Run \`./pi-template doctor\`.`);
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((ready, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", ready); });
  const { port } = server.address();
  await new Promise((closed) => server.close(closed));
  return port;
}

async function webPort(env) {
  const raw = env.PI_TEMPLATE_WEB_PORT?.trim();
  if (!raw) return DEFAULT_WEB_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new LaunchError("PI_TEMPLATE_WEB_PORT must be an integer from 0 through 65535.");
  }
  return port === 0 ? await freePort() : port;
}

async function probe(url) {
  let response;
  try {
    response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(2_000) });
  } catch {
    return undefined;
  }
  try {
    return { status: response.status, body: await response.json() };
  } catch {
    return { status: response.status, body: undefined };
  }
}

const isAppStatus = (answer) => answer?.status === 200 && ["ready", "setup", "down"].includes(answer.body?.daemon);

function describeAnswer(answer) {
  if (!answer) return "nothing answered";
  if (answer.body === undefined) return `answered ${answer.status} with a non-JSON body`;
  return `answered ${answer.status} with ${JSON.stringify(answer.body).slice(0, 120)}`;
}

async function waitForReady(statusUrl, childExited) {
  const deadline = Date.now() + WEB_READY_TIMEOUT_MS;
  let last;
  for (;;) {
    if (childExited()) return { ok: false, last, exited: true };
    const answer = await probe(statusUrl);
    if (answer) last = answer;
    if (isAppStatus(answer) && answer.body.daemon === "ready") return { ok: true, last };
    if (Date.now() >= deadline) return { ok: false, last };
    await sleep(POLL_MS);
  }
}

let web;
let webExit;
let stopping = false;

/** The web server runs as its own process group, so one signal reaches npm, Next, and its workers. */
async function stopWeb() {
  if (!web || webExit) return;
  try { process.kill(-web.pid, "SIGTERM"); } catch {}
  const exited = new Promise((done) => web.once("exit", done));
  const forced = sleep(5_000).then(() => { try { process.kill(-web.pid, "SIGKILL"); } catch {} });
  await Promise.race([exited, forced]);
}

/** A second signal while stopping kills the web group outright. SIGHUP is a closed terminal. */
const stop = (code, message) => {
  if (stopping) {
    try { process.kill(-web.pid, "SIGKILL"); } catch {}
    process.exit(code);
  }
  stopping = true;
  const exit = () => (message ? process.stderr.write(`pi-template: ${message}\n`, () => process.exit(code)) : process.exit(code));
  void stopWeb().then(exit, () => process.exit(1));
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => stop(0));
process.stdout.on("error", (error) => stop(1, `nothing is reading stdout (${error.code})${web ? "; stopped the web app" : ""}.`));

async function main() {
  const env = { ...process.env };
  await startDaemonViaStatus(env);
  const port = await webPort(env);
  const url = `http://127.0.0.1:${port}`;
  const ready = `pi-template: app ready at ${url}\n`;

  const existing = await probe(`${url}/api/status`);
  if (existing) {
    if (!isAppStatus(existing)) {
      throw new LaunchError(
        `something on port ${port} is not this app (${describeAnswer(existing)}). Stop it, or set PI_TEMPLATE_WEB_PORT to a free port.`,
      );
    }
    // The default home of harnessPaths() in @pi-template/contracts/harness-home.
    const home = env.PI_TEMPLATE_HOME ?? join(homedir(), ".pi-template");
    if (existing.body.home !== home) {
      throw new LaunchError(
        `the app on port ${port} serves ${existing.body.home}, not ${home}. Stop it, or set PI_TEMPLATE_WEB_PORT to a free port.`,
      );
    }
    const settled = await waitForReady(`${url}/api/status`, () => false);
    if (!settled.ok) throw new LaunchError(`the app already running at ${url} cannot reach the daemon. Run \`./pi-template doctor\`.`);
    process.stdout.write(ready);
    return;
  }

  web = spawn("npm", ["--prefix", join(repositoryRoot, "apps", "web"), "run", "dev", "--", "--port", String(port)], {
    cwd: repositoryRoot,
    env: { ...env, NEXT_TELEMETRY_DISABLED: "1" },
    detached: true,
    stdio: ["ignore", process.stderr, process.stderr],
  });
  const exited = new Promise((done) => web.once("exit", (code, signal) => { webExit = { code, signal }; done(webExit); }));

  const settled = await waitForReady(`${url}/api/status`, () => Boolean(webExit));
  if (!settled.ok) {
    if (settled.exited) {
      throw new LaunchError(`the web app exited ${webExit.signal ? `on ${webExit.signal}` : `with code ${webExit.code}`} before it was ready; its output is above.`);
    }
    if (settled.last?.body?.daemon === "setup") throw new LaunchError("setup is incomplete. Run `./pi-template onboard`, then `npm start` again.");
    if (isAppStatus(settled.last)) throw new LaunchError(`the app at ${url} cannot reach the daemon. Run \`./pi-template doctor\`.`);
    throw new LaunchError(`the app at ${url} did not answer as this app (${describeAnswer(settled.last)}). Its output is above.`);
  }
  process.stdout.write(ready);
  const { code, signal } = await exited;
  if (!stopping) {
    process.stderr.write(`pi-template: the web app exited ${signal ? `on ${signal}` : `with code ${code}`}\n`);
    process.exitCode = code === 0 ? 0 : 1;
  }
}

try {
  await main();
} catch (error) {
  await stopWeb();
  process.stderr.write(`pi-template: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
