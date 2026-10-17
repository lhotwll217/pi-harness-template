import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseQueryAction, ScheduleRunStatus, harnessPaths } from "@pi-template/contracts";
import { runOnboarding } from "../agent";
import { startDaemon } from "../daemon";
import { connectGateway } from "../gateway";
import { passingOnboardingDependencies, testOnboardingAnswers } from "../../test/helpers/onboarding";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = join(repositoryRoot, "pi-template");
const home = mkdtempSync(join(tmpdir(), "pi-template-cli-e2e-"));
const previousHome = process.env.PI_TEMPLATE_HOME;
process.env.PI_TEMPLATE_HOME = home;
// Ephemeral port: an auto-started daemon must never collide with a real one on this machine.
const childEnvironment: NodeJS.ProcessEnv = { ...process.env, PI_TEMPLATE_HOME: home, PI_TEMPLATE_PORT: "0" };
delete childEnvironment.NODE_USE_SYSTEM_CA;
let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

const runCli = async (args: readonly string[]) => await new Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}>((resolveRun, reject) => {
  const child = spawn(executable, args, { cwd: repositoryRoot, env: childEnvironment });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (status) => resolveRun({ status, stdout, stderr }));
});

async function runTest(): Promise<void> {
try {
  const firstRunHeadless = await runCli([]);
  assert.equal(firstRunHeadless.status, 2);
  assert.equal(firstRunHeadless.stdout, "");
  assert.match(
    firstRunHeadless.stderr,
    /pi-template: setup required; run `pi-template` in an interactive terminal/,
  );

  // No daemon running: the command starts one itself and succeeds — docs are served
  // pre-onboarding under the model-free diagnostics exception. The auto-started daemon
  // is then stopped so the in-process composed daemon below owns the home.
  const noDaemon = await runCli(["docs", "list"]);
  assert.equal(noDaemon.status, 0, noDaemon.stderr);
  const autoStartedDocs = JSON.parse(noDaemon.stdout) as Array<{ id: string }>;
  assert.ok(autoStartedDocs.some(({ id }) => id === "architecture"));
  const autoInfo = JSON.parse(readFileSync(harnessPaths(home).daemonInfo, "utf8")) as { pid: number };
  process.kill(autoInfo.pid, "SIGTERM");
  for (let waited = 0; existsSync(harnessPaths(home).daemonInfo); waited += 50) {
    if (waited > 5_000) throw new Error("auto-started daemon did not shut down");
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
  }

  try {
    daemon = await startDaemon({
      port: 0,
      fingerprintIntervalMs: 60_000,
      scheduler: {
        wakeIntervalMs: 60_000,
        promptRunner: async () => ({ exitCode: 0, stdout: "fake model", stderr: "" }),
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      process.stdout.write("SKIP — real CLI e2e requires loopback bind permission\n");
      return;
    }
    throw error;
  }

  await runOnboarding(
    testOnboardingAnswers(home),
    passingOnboardingDependencies(home),
  );

  const bareReady = await runCli([]);
  assert.equal(bareReady.status, 0, bareReady.stderr);
  assert.equal(
    (JSON.parse(bareReady.stdout) as { ready: { setupRequired: boolean } }).ready.setupRequired,
    false,
  );

  const status = await runCli(["status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal((JSON.parse(status.stdout) as { ready: { setupRequired: boolean } }).ready.setupRequired, false);
  const secondDaemon = await runCli(["daemon"]);
  assert.equal(secondDaemon.stderr, "pi-template: another daemon already owns the loopback port\n");
  assert.equal(secondDaemon.status, 1);
  const doctor = await runCli(["doctor"]);
  assert.ok([0, 1].includes(doctor.status ?? -1), doctor.stderr);
  assert.equal((JSON.parse(doctor.stdout) as { checks: { roots: { harnessHome: string } } }).checks.roots.harnessHome, home);

  const added = await runCli(["notes", "add", "visible from the CLI"]);
  assert.equal(added.status, 0, added.stderr);
  const note = JSON.parse(added.stdout) as { id: string; body: string };
  assert.equal(note.body, "visible from the CLI");
  const listed = await runCli(["notes", "list"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok((JSON.parse(listed.stdout) as Array<{ id: string }>).some(({ id }) => id === note.id));

  for (const [words, body] of [
    [["-5", "degrees"], "-5 degrees"],
    [["note", "--", "-x"], "note -- -x"],
    [["--frob", "it"], "--frob it"],
  ] as const) {
    const dashed = await runCli(["notes", "add", ...words]);
    assert.equal(dashed.status, 0, dashed.stderr);
    assert.equal((JSON.parse(dashed.stdout) as { body: string }).body, body);
  }
  const dashedQuestion = await runCli(["docs", "query", "what", "is", "--json"]);
  assert.equal(dashedQuestion.status, 0, dashedQuestion.stderr);

  const tables = await runCli(["db", "tables"]);
  assert.equal(tables.status, 0, tables.stderr);
  assert.deepEqual(
    (JSON.parse(tables.stdout) as Array<{ name: string }>).map(({ name }) => name),
    ["notes", "schedule_runs", "schedules", "schema_migrations"],
  );
  const described = await runCli(["db", "describe", "notes"]);
  assert.equal(described.status, 0, described.stderr);
  assert.deepEqual(
    (JSON.parse(described.stdout) as { columns: Array<{ name: string; description: string }> }).columns
      .map(({ name, description }) => [name, description]),
    [
      ["id", "Stable note id."],
      ["body", "Owner-authored note text."],
      ["created_at", "ISO creation time."],
      ["updated_at", "ISO last-update time."],
    ],
  );

  const commented = await runCli(["db", "query", "-- leading comment\nSELECT 1 AS one"]);
  assert.equal(commented.status, 0, "SQL that opens with a -- comment is SQL, not an unknown option");
  assert.deepEqual(JSON.parse(commented.stdout), { rows: [{ one: 1 }], truncated: false });

  const write = await runCli(["db", "query", "UPDATE notes SET body = 'x'"]);
  assert.equal(write.status, 1);
  assert.equal(write.stdout, "");
  assert.deepEqual(JSON.parse(write.stderr), {
    status: 400,
    error: "not authorized",
    hint: "`pi-template db query` runs one read-only SELECT against the state database.",
  });
  assert.equal(write.stderr.trimEnd().split("\n").length, 1, "a failure is one JSON line on stderr");
  const trailing = await runCli(["db", "query", "SELECT 1; DELETE FROM notes"]);
  assert.equal(trailing.status, 1);
  assert.deepEqual(JSON.parse(trailing.stderr), {
    status: 400,
    error: "db query runs one statement; found more after the first",
    hint: "Send each statement in its own `pi-template db query`.",
  });
  const vacuum = await runCli(["db", "query", "VACUUM"]);
  assert.equal(vacuum.status, 1);
  assert.deepEqual(JSON.parse(vacuum.stderr), {
    status: 400,
    error: "authorization denied",
    hint: "`pi-template db query` runs one read-only SELECT against the state database.",
  });
  const unchanged = await runCli(["db", "query", "SELECT body FROM notes WHERE body = 'visible from the CLI'"]);
  assert.deepEqual(JSON.parse(unchanged.stdout), { rows: [{ body: "visible from the CLI" }], truncated: false });

  const misspelled = await runCli(["db", "query", "SELECT * FROM note"]);
  assert.equal(misspelled.status, 1);
  assert.deepEqual(JSON.parse(misspelled.stderr), {
    status: 400,
    error: "no such table: note",
    hint: "`pi-template db tables` lists every table.",
    closest: ["notes"],
  });

  const large = await runCli(["db", "query", "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n LIMIT 500) SELECT i FROM n"]);
  assert.equal(large.status, 0, large.stderr);
  const capped = JSON.parse(large.stdout) as { rows: unknown[]; truncated: boolean; hint: string };
  assert.equal(capped.rows.length, 200);
  assert.equal(capped.truncated, true);
  assert.equal(capped.hint, "add WHERE or LIMIT, select fewer or shorter columns, or aggregate with count(*) and GROUP BY");

  const client = await connectGateway();
  assert.ok(client);
  const queried = await client.queryDatabase({
    action: DatabaseQueryAction.Query,
    sql: "SELECT body FROM notes WHERE body = 'visible from the CLI'",
  }) as { rows: Array<{ body: string }> };
  assert.deepEqual(queried.rows, [{ body: "visible from the CLI" }]);

  const docs = await runCli(["docs", "query", "how do I add a scheduled prompt"]);
  assert.equal(docs.status, 0, docs.stderr);
  assert.equal((JSON.parse(docs.stdout) as { matches: Array<{ id: string }> }).matches[0]?.id, "scheduler");

  const scheduled = await runCli([
    "schedule", "add", "--name", "CLI command", "--every", "1h", "--timeout", "10",
    "--", process.execPath, "-e", "process.stdout.write('scheduled command ran')",
  ]);
  assert.equal(scheduled.status, 0, scheduled.stderr);
  const schedule = JSON.parse(scheduled.stdout) as { id: string };
  const exact = await runCli(["schedule", "add", "--every", "1h", "--name", "exact", "--", "node", "-h", "--every", "2h", "--"]);
  assert.equal(exact.status, 0, exact.stderr);
  assert.deepEqual(
    (JSON.parse(exact.stdout) as { payload: { argv: string[] } }).payload.argv,
    ["node", "-h", "--every", "2h", "--"],
    "every word after the first -- is the command, as typed",
  );
  const run = await runCli(["schedule", "run", schedule.id]);
  assert.equal(run.status, 0, run.stderr);
  const completed = JSON.parse(run.stdout) as { status: string; stdout_tail: string };
  assert.equal(completed.status, ScheduleRunStatus.Completed);
  assert.equal(completed.stdout_tail, "scheduled command ran");
  const schedules = await runCli(["schedule", "list"]);
  assert.ok((JSON.parse(schedules.stdout) as Array<{ id: string }>).some(({ id }) => id === schedule.id));
  client.close();

  process.stdout.write("ok — CLI traverses Gateway for docs, notes, read-only db, and command schedules, printing JSON\n");
} finally {
  await daemon?.close();
  if (previousHome === undefined) delete process.env.PI_TEMPLATE_HOME;
  else process.env.PI_TEMPLATE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
}
}

await runTest();
