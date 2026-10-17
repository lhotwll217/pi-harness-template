import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "pi-template-start-"));
mkdirSync(join(root, "scripts"));
mkdirSync(join(root, "apps", "web"), { recursive: true });
copyFileSync(join(repositoryRoot, "scripts", "start.mjs"), join(root, "scripts", "start.mjs"));

writeFileSync(join(root, "pi-template"), `#!/bin/sh
if [ ! -f "${root}/daemon.pid" ]; then
  nohup sleep 120 >/dev/null 2>&1 &
  echo $! > "${root}/daemon.pid"
fi
case "$FAKE_STATUS" in
  setup) echo '{"health":{"ok":true},"ready":{"ready":false,"setupRequired":true,"modules":{"state":true,"scheduler":true,"gateway":true}}}' ;;
  *) echo '{"health":{"ok":true},"ready":{"ready":true,"setupRequired":false,"modules":{"state":true,"scheduler":true,"gateway":true}}}' ;;
esac
`);
chmodSync(join(root, "pi-template"), 0o755);

writeFileSync(join(root, "apps", "web", "package.json"), JSON.stringify({ name: "web", private: true, scripts: { dev: "node server.cjs" } }));
writeFileSync(join(root, "apps", "web", "server.cjs"), `
const { execFileSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
writeFileSync(${JSON.stringify(join(root, "web.pid"))}, String(process.pid));
writeFileSync(${JSON.stringify(join(root, "web.pgid"))}, execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
console.log("stand-in dev server on " + port);
require("node:http").createServer((request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ daemon: "ready", home: process.env.PI_TEMPLATE_HOME }));
}).listen(port, "127.0.0.1");
`);

const home = join(root, "home");

interface Launch { stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }

function launch(
  env: NodeJS.ProcessEnv,
  onStdout?: (stdout: string, child: ReturnType<typeof spawn>) => void,
  closeStdout = false,
): Promise<Launch> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(root, "scripts", "start.mjs")], {
      cwd: root,
      env: { ...process.env, PI_TEMPLATE_HOME: home, PI_TEMPLATE_WEB_PORT: "0", ...env },
    });
    if (closeStdout) child.stdout.destroy();
    let stdout = "";
    let stderr = "";
    const deadline = setTimeout(() => { child.kill("SIGKILL"); fail(new Error(`launch timed out; stderr: ${stderr}`)); }, 30_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; onStdout?.(stdout, child); });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("exit", (code, signal) => { clearTimeout(deadline); done({ stdout, stderr, code, signal }); });
  });
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const webGroups: number[] = [];
const webGroup = (): number => {
  const pgid = Number(readFileSync(join(root, "web.pgid"), "utf8"));
  webGroups.push(pgid);
  return pgid;
};

const groupAlive = (pgid: number): boolean => {
  try { process.kill(-pgid, 0); return true; } catch { return false; }
};

async function waitForGroupGone(pgid: number): Promise<void> {
  for (let waited = 0; groupAlive(pgid) && waited < 8_000; waited += 50) await new Promise((r) => setTimeout(r, 50));
}

async function stub(body: unknown): Promise<{ server: Server; port: number }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { server, port: (server.address() as AddressInfo).port };
}

try {
  let url = "";
  const started = await launch({}, (stdout, child) => {
    if (!stdout.endsWith("\n") || url) return;
    url = stdout.trim().replace("pi-template: app ready at ", "");
    void fetch(`${url}/api/status`).then((response) => response.json()).then((body) => {
      assert.deepEqual(body, { daemon: "ready", home });
      child.kill("SIGINT");
    });
  });
  assert.match(started.stdout, /^pi-template: app ready at http:\/\/127\.0\.0\.1:\d+\n$/);
  assert.equal(started.code, 0, started.stderr);
  assert.match(started.stderr, /stand-in dev server on \d+/);
  const webPid = Number(readFileSync(join(root, "web.pid"), "utf8"));
  const daemonPid = Number(readFileSync(join(root, "daemon.pid"), "utf8"));
  for (let waited = 0; alive(webPid) && waited < 5_000; waited += 50) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(webPid), false, "the web server this launch started stops on Ctrl-C");
  assert.equal(alive(daemonPid), true, "the daemon keeps running");

  rmSync(join(root, "web.pid"));
  let hungUpGroup = 0;
  const hungUp = await launch({}, (stdout, child) => {
    if (!stdout.endsWith("\n") || hungUpGroup) return;
    hungUpGroup = webGroup();
    child.kill("SIGHUP");
  });
  assert.notEqual(hungUpGroup, 0);
  await waitForGroupGone(hungUpGroup);
  assert.equal(groupAlive(hungUpGroup), false, "a closed terminal (SIGHUP) stops the whole web process group");
  assert.equal(hungUp.code, 0, hungUp.stderr);

  rmSync(join(root, "web.pid"));
  const unread = await launch({}, undefined, true);
  const unreadGroup = webGroup();
  await waitForGroupGone(unreadGroup);
  assert.equal(groupAlive(unreadGroup), false, "a reader that closes stdout (`npm start | head -n1`) stops the web process group");
  assert.equal(unread.code, 1);
  assert.equal(unread.stderr.split("\n").filter((line) => line.startsWith("pi-template:")).join("\n"),
    "pi-template: nothing is reading stdout (EPIPE); stopped the web app.");

  rmSync(join(root, "web.pid"));
  const elsewhere = await stub({ daemon: "ready", home: "/elsewhere/pi-template-home" });
  const mismatched = await launch({ PI_TEMPLATE_WEB_PORT: String(elsewhere.port) });
  elsewhere.server.close();
  assert.equal(mismatched.code, 1);
  assert.equal(mismatched.stdout, "");
  assert.equal(
    mismatched.stderr,
    `pi-template: the app on port ${elsewhere.port} serves /elsewhere/pi-template-home, not ${home}. Stop it, or set PI_TEMPLATE_WEB_PORT to a free port.\n`,
  );

  const running = await stub({ daemon: "ready", home });
  const reused = await launch({ PI_TEMPLATE_WEB_PORT: String(running.port) });
  running.server.close();
  assert.equal(reused.stdout, `pi-template: app ready at http://127.0.0.1:${running.port}\n`);
  assert.equal(reused.code, 0, reused.stderr);
  assert.equal(existsSync(join(root, "web.pid")), false);

  const stranger = await stub({ hello: "world" });
  const refused = await launch({ PI_TEMPLATE_WEB_PORT: String(stranger.port) });
  stranger.server.close();
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, "");
  assert.equal(
    refused.stderr,
    `pi-template: something on port ${stranger.port} is not this app (answered 200 with {"hello":"world"}). Stop it, or set PI_TEMPLATE_WEB_PORT to a free port.\n`,
  );

  const setup = await launch({ FAKE_STATUS: "setup" });
  assert.equal(setup.code, 1);
  assert.equal(setup.stdout, "");
  assert.equal(setup.stderr, "pi-template: setup is incomplete. Run `./pi-template onboard`, then `npm start` again.\n");

  const badPort = await launch({ PI_TEMPLATE_WEB_PORT: "web" });
  assert.equal(badPort.stderr, "pi-template: PI_TEMPLATE_WEB_PORT must be an integer from 0 through 65535.\n");
  console.log("✓ npm start prints the app URL, reuses its own app, refuses a stranger or another home, stops the web group on Ctrl-C, SIGHUP, or a closed stdout, and leaves the daemon");
} finally {
  for (const pgid of webGroups) {
    try { process.kill(-pgid, "SIGKILL"); } catch {}
  }
  for (const file of ["web.pid", "daemon.pid"]) {
    try { process.kill(Number(readFileSync(join(root, file), "utf8")), "SIGKILL"); } catch {}
  }
  rmSync(root, { recursive: true, force: true });
}
