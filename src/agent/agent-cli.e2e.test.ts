import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createNetServer, type Socket } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  AgentToolId,
  DEFAULT_TOOL_POSTURE,
  ONBOARDING_VERSION,
  ScheduleKind,
  ScheduleRunStatus,
  ScheduledPayloadKind,
  ensureHarnessWorkspace,
  harnessPaths,
  saveHarnessSettings,
  savePermissionMode,
  type ScheduledPromptRunRequest,
} from "@pi-template/contracts";
import { startDaemon } from "../daemon";
import { connectGateway } from "../gateway";
import { runPromptSession } from "../cli/interactive";
import { seedFauxProviderHome } from "../../test/helpers/faux-provider";
import { acknowledgeAgentDefinition } from "../../test/helpers/onboarding";
import { toolResultFromTurn } from "../../test/helpers/tool-turn";
import { createScheduledPromptRunner } from "./prompt-runner";
import { createHarnessSession } from "./runtime";
import { checkoutRoot, createSandboxAdapter } from "./sandbox";

// A unix socket path holds at most 103 bytes on macOS, and the temporary directory is long.
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-agent-cli-")));
const home = join(root, "home");
const cwd = join(root, "task");
const previousHome = process.env.PI_TEMPLATE_HOME;
process.env.PI_TEMPLATE_HOME = home;
const faux = registerFauxProvider();
let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;

interface AgentTurn {
  results: string[];
  tools: string[];
  answer: string;
}

const textOf = (message: Message | undefined): string =>
  message?.role === "toolResult" ? message.content.map((part) => part.type === "text" ? part.text : "").join("") : "";

function offeredTools(messages: readonly Message[]): string[] {
  const tools = new Set<string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  }
  return [...tools];
}

async function agentTurn(commands: readonly string[], answer: (results: string[]) => string): Promise<AgentTurn> {
  const turn: AgentTurn = { results: [], tools: [], answer: "" };
  faux.setResponses([
    ...commands.map((command, index) => (context: { messages: Message[] }) => {
      if (index === 0) turn.tools = offeredTools(context.messages);
      else turn.results.push(textOf(context.messages.at(-1)));
      return fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" });
    }),
    (context: { messages: Message[] }) => {
      turn.results.push(textOf(context.messages.at(-1)));
      return fauxAssistantMessage(answer(turn.results));
    },
  ]);
  const write = process.stdout.write;
  process.stdout.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
    turn.answer += String(chunk);
    (typeof encoding === "function" ? encoding : callback as (() => void) | undefined)?.();
    return true;
  }) as typeof process.stdout.write;
  try {
    const exitCode = await runPromptSession({ home, cwd, model: faux.getModel(), message: "Use pi-template in bash." });
    assert.equal(exitCode, 0);
  } finally {
    process.stdout.write = write;
  }
  turn.answer = turn.answer.trim();
  return turn;
}

const countAnswer = ([listed]: string[]) => `There are ${(JSON.parse(listed!) as unknown[]).length} notes saved.`;

interface OwnerTurn {
  results: string[];
  prompts: string[];
}

/** One interactive session whose owner answers "Yes, for this session" to the first prompt and "Yes" to every later one. */
async function ownerTurn(commands: readonly string[]): Promise<OwnerTurn> {
  const turn: OwnerTurn = { results: [], prompts: [] };
  faux.setResponses([
    ...commands.map((command, index) => (context: { messages: Message[] }) => {
      if (index > 0) turn.results.push(textOf(context.messages.at(-1)));
      return fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" });
    }),
    (context: { messages: Message[] }) => {
      turn.results.push(textOf(context.messages.at(-1)));
      return fauxAssistantMessage("done");
    },
  ]);
  const created = await createHarnessSession({ home, cwd, model: faux.getModel(), ephemeral: true });
  // Pi's no-op UI with a select that answers; "rpc" makes the permission extension ask through select.
  const owner: ExtensionUIContext = {
    ...created.session.extensionRunner.getUIContext(),
    select: async (title, options) => {
      turn.prompts.push(title);
      return turn.prompts.length === 1 ? options[1] : options[0];
    },
  };
  try {
    await created.session.bindExtensions({ uiContext: owner, mode: "rpc" });
    await created.session.prompt("Use bash.");
  } finally {
    await created.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    created.session.dispose();
  }
  return turn;
}

async function agentCli(args: readonly string[], agentHome: string) {
  return await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
    const child = spawn(join(checkoutRoot, "pi-template"), args, {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, PI_TEMPLATE_HOME: agentHome, PI_TEMPLATE_AGENT: "1" },
      timeout: 15_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

const NO_DAEMON = '{"error":"the pi-template daemon is not running",' +
  '"hint":"the owner starts it with `pi-template status`; the agent never starts it"}';
const COMMAND_SCHEDULE_REFUSAL = '{"status":403,"error":"agent callers cannot create, change, or run a command schedule",' +
  '"hint":"the owner runs pi-template schedule add -- <argv>"}';
const refusal = (mode: string, reason: string) => mode === "ask"
  ? `Refused in ask mode: a bash command that names pi-template must be pi-template <command> [arguments] ` +
    `as plain words, and ${reason}. Quote arguments with '...' or "..."; variables, redirects, pipes, globs, and chained commands ` +
    "are refused around pi-template. A command that does not name pi-template needs the owner's approval."
  : `Refused in ${mode} mode: the agent's bash runs only pi-template <command> [arguments] ` +
    `as plain words, and ${reason}. Quote arguments with '...' or "..."; variables, redirects, pipes, globs, and chained commands are refused.`;
const NO_APPROVER = "[pi-permission-system] This 'bash' call (rule '*') requires approval, but no interactive UI is available.";
const sandboxPolicy = (enabled: boolean) => JSON.stringify({
  enabled,
  filesystem: { allowedReadRoots: [cwd], allowedWriteRoots: [cwd], deniedReadRoots: [] },
  process: { allowSubprocesses: true },
  network: { mode: "deny", allowedDomains: [] },
});

try {
  const paths = ensureHarnessWorkspace(home);
  mkdirSync(join(cwd, "workspace"), { recursive: true });
  writeFileSync(join(cwd, "workspace", "keep.txt"), "kept\n");
  seedFauxProviderHome(paths, faux.getModel());
  acknowledgeAgentDefinition(paths);
  saveHarnessSettings(home, { alwaysOn: "declined" });
  writeFileSync(paths.sandboxPolicy, sandboxPolicy(false));
  writeFileSync(paths.onboardingMarker, JSON.stringify({ version: ONBOARDING_VERSION, completedAt: "2026-10-17T00:00:00.000Z" }));

  const absentHome = join(root, "absent");
  ensureHarnessWorkspace(absentHome);
  const noDaemon = await agentCli(["notes", "list"], absentHome);
  assert.deepEqual(noDaemon, { status: 1, stdout: "", stderr: `${NO_DAEMON}\n` });
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 2_000));
  assert.equal(existsSync(harnessPaths(absentHome).daemonInfo), false, "no daemon published discovery");
  assert.equal(existsSync(harnessPaths(absentHome).agentSocket), false, "no daemon listens for the agent");
  const hungSockets = new Set<Socket>();
  const hung = createNetServer((socket) => { hungSockets.add(socket); });
  await new Promise<void>((resolveListen) => hung.listen(harnessPaths(absentHome).agentSocket, resolveListen));
  assert.deepEqual(await agentCli(["notes", "list"], absentHome), {
    status: 1,
    stdout: "",
    stderr: '{"error":"the pi-template daemon did not answer within 1 s","hint":"tell the owner the daemon is not answering; the agent never restarts it"}\n',
  });
  await new Promise<void>((resolveClose) => { hung.close(() => resolveClose()); for (const socket of hungSockets) socket.destroy(); });
  for (const [args, command] of [
    [["--", "daemon"], "pi-template with a leading --"],
    [["--", "prompt", "hi"], "pi-template with a leading --"],
    [["onboard", "--permission", "allow"], "pi-template onboard"],
    [["daemon"], "pi-template daemon"],
    [["prompt", "hi"], "pi-template prompt"],
    [[], "pi-template with no command"],
  ] as const) {
    assert.deepEqual(await agentCli(args, absentHome), {
      status: 2,
      stdout: "",
      stderr: `{"error":"${command} is the owner's command","hint":"the agent runs pi-template db | docs | notes | schedule | status | doctor"}\n`,
    });
  }

  daemon = await startDaemon({ port: 0, fingerprintIntervalMs: 60_000, scheduler: { wakeIntervalMs: 60_000 } });
  const owner = await connectGateway();
  assert.ok(owner);
  for (const body of ["renew the certificate", "call the bank", "water the plants"]) await owner.createNote({ body });

  const counted = await agentTurn(["pi-template notes list"], countAnswer);
  assert.equal(counted.answer, "There are 3 notes saved.");
  assert.deepEqual((JSON.parse(counted.results[0]!) as Array<{ body: string }>).map(({ body }) => body).sort(),
    ["call the bank", "renew the certificate", "water the plants"]);
  assert.deepEqual(counted.tools.sort(), [...DEFAULT_TOOL_POSTURE].sort());
  const queried = await agentTurn(["pi-template db query 'SELECT count(*) AS n FROM notes'"], ([result]) => result!);
  assert.deepEqual(JSON.parse(queried.results[0]!), { rows: [{ n: 3 }], truncated: false });

  const environment = await agentTurn(['echo "$PI_TEMPLATE_HOME $PI_TEMPLATE_AGENT ${PI_TEMPLATE_PORT:-no-port}"'], ([result]) => result!);
  assert.equal(environment.results[0], `${home} 1 no-port\n`);

  const saved = await agentTurn([
    'pi-template notes add "buy milk"',
    'pi-template schedule add --every 1d --name "daily summary" --prompt "summarize the notes kept today"',
  ], () => "Saved the note and scheduled the summary.");
  assert.equal((JSON.parse(saved.results[0]!) as { body: string }).body, "buy milk");
  assert.ok((await owner.listNotes()).some(({ body }) => body === "buy milk"));
  const scheduled = (await owner.listSchedules()).find(({ name }) => name === "daily summary");
  assert.deepEqual(scheduled?.payload, { kind: ScheduledPayloadKind.Prompt, prompt: "summarize the notes kept today", toolsAllow: [] });

  const commandAttempt = await agentTurn(["pi-template schedule add --every 1d --name escalate -- touch /tmp/owned"], ([result]) => result!);
  assert.equal(commandAttempt.results[0], `${COMMAND_SCHEDULE_REFUSAL}\n\n\nCommand exited with code 1`);
  assert.equal((await owner.listSchedules()).some(({ name }) => name === "escalate"), false);
  const ownerCommand = await owner.createSchedule({
    name: "owner command", enabled: false, cwd: root, timeoutSeconds: 30,
    trigger: { kind: ScheduleKind.Every, everyMs: 86_400_000, anchorMs: Date.now() },
    payload: { kind: ScheduledPayloadKind.Command, argv: ["true"] },
  });
  const runAttempt = await agentTurn([`pi-template schedule run ${ownerCommand.id}`], ([result]) => result!);
  assert.equal(runAttempt.results[0], `${COMMAND_SCHEDULE_REFUSAL}\n\n\nCommand exited with code 1`);
  assert.deepEqual(daemon.state.listRuns(ownerCommand.id), []);

  const doctor = await agentTurn(["pi-template doctor"], ([result]) => result!);
  assert.deepEqual(JSON.parse(doctor.results[0]!.replace(/\n\n\nCommand exited with code 1$/, "")).checks.agentCli, {
    reachable: true,
    reason: `the agent's bash reaches the daemon through ${paths.agentSocket}`,
  });

  const ownerRules = JSON.parse(readFileSync(paths.piPermissionConfig, "utf8")) as { permission: { bash: Record<string, string> } };
  writeFileSync(paths.piPermissionConfig, JSON.stringify({
    permission: { ...ownerRules.permission, bash: { ...ownerRules.permission.bash, "pi-template db *": "deny" } },
  }));
  for (const mode of ["allow", "ask", "read-only"] as const) {
    savePermissionMode(home, mode);
    const denied = await agentTurn(["pi-template db query 'SELECT count(*) FROM notes'"], ([result]) => result!);
    assert.equal(denied.results[0], "[pi-permission-system] Denied by policy: 'bash' (rule 'pi-template db *').", mode);
  }
  writeFileSync(paths.piPermissionConfig, JSON.stringify(ownerRules));

  savePermissionMode(home, "read-only");
  const readOnly = await agentTurn([
    "pi-template notes list",
    'pi-template db query "SELECT 1"; rm -rf workspace',
    "pi-template notes list > notes.json",
  ], countAnswer);
  assert.equal(readOnly.answer, "There are 4 notes saved.");
  assert.deepEqual(readOnly.tools.sort(), ["bash", "find", "grep", "ls", "read"]);
  // The chained rm falls to read-only's `*` deny (here on its path, before its command); the CLI rule never covers it.
  assert.equal(readOnly.results[1], "[pi-permission-system] Denied by policy: 'path' for tool 'bash' for path 'workspace' (rule '*').");
  assert.equal(readFileSync(join(cwd, "workspace", "keep.txt"), "utf8"), "kept\n");
  assert.match(readOnly.results[2]!, /^\[pi-permission-system\] Denied by policy: 'path_write'/);
  assert.equal(existsSync(join(cwd, "notes.json")), false);

  const marker = join(cwd, "spoofed");
  const spoofs = (scheduleId: string) => [
    `PI_TEMPLATE_AGENT=0 pi-template schedule add --every 1d --name spoofed -- true`,
    `PI_TEMPLATE_AGENT=0 pi-template schedule run ${scheduleId}`,
    "NODE_OPTIONS='--import=data:text/javascript,import(`node:fs`).then((fs)=>fs.writeFileSync(`" + marker + "`,``))' pi-template notes list",
  ];
  const assertSpoofsRefused = async (mode: "read-only" | "ask", label: string): Promise<void> => {
    savePermissionMode(home, mode);
    const spoofed = await agentTurn([...spoofs(ownerCommand.id), "pi-template notes list"], ([, , , listed]) => countAnswer([listed!]));
    assert.deepEqual(spoofed.results.slice(0, 3), Array(3).fill(refusal(mode, "its first word is not pi-template")), label);
    assert.equal(spoofed.answer, "There are 4 notes saved.", label);
    assert.equal(existsSync(marker), false, label);
    assert.equal((await owner.listSchedules()).some(({ name }) => name === "spoofed"), false, label);
    assert.deepEqual(daemon!.state.listRuns(ownerCommand.id), [], label);
  };
  const assertOwnerApprovalsHold = async (label: string): Promise<void> => {
    savePermissionMode(home, "ask");
    const spoofed = await ownerTurn([
      "ls workspace",
      "X=1 pi-template notes list",
      `env PI_TEMPLATE_AGENT=0 pi-template schedule run ${ownerCommand.id}`,
      "ls workspace && NODE_OPTIONS='--import=data:text/javascript,import(`node:fs`).then((fs)=>fs.writeFileSync(`" + marker + "`,``))' pi-template notes list",
      `PI_TEMPLATE_AGENT=0 ${checkoutRoot}/pi-template schedule add --every 1d --name spoofed -- true`,
      "ls workspace; PI_TEMPLATE_AGENT=0 pi-template schedule add --every 1d --name spoofed -- true",
      "ls workspace; PI_TEMPLATE_AGENT=0 Pi-Template schedule add --every 1d --name spoofed -- true",
      `PI_TEMPLATE_AGENT=0 ${checkoutRoot}/PI-TEMPLATE schedule run ${ownerCommand.id}`,
      "pi-template notes list",
    ]);
    assert.equal(spoofed.results[0], "keep.txt\n", label);
    assert.deepEqual(spoofed.results.slice(1, 8), [
      refusal("ask", "its first word is not pi-template"),
      refusal("ask", "its first word is not pi-template"),
      refusal("ask", "it has & outside quotes"),
      refusal("ask", "its first word is not pi-template"),
      refusal("ask", "it has ; outside quotes"),
      refusal("ask", "it has ; outside quotes"),
      refusal("ask", "its first word is not pi-template"),
    ], label);
    assert.equal((JSON.parse(spoofed.results[8]!) as unknown[]).length, 4, label);
    // Only the owner's ls and the spellings no generated rule matches prompted; the owner said yes to each.
    assert.deepEqual(spoofed.prompts.map((prompt) => prompt.replace(/\s+/g, " ")), [
      "Permission Required tool : bash rule : * command : ls workspace",
      `Permission Required tool : bash rule : * command : env PI_TEMPLATE_AGENT=0 pi-template schedule run ${ownerCommand.id} ` +
        `runs : pi-template schedule run ${ownerCommand.id}`,
      `Permission Required tool : bash rule : * command : ${checkoutRoot}/pi-template schedule add --every 1d --name spoofed -- true ` +
        `full command : PI_TEMPLATE_AGENT=0 ${checkoutRoot}/pi-template schedule add --every 1d --name spoofed -- true`,
      "Permission Required tool : bash rule : * command : Pi-Template schedule add --every 1d --name spoofed -- true " +
        "full command : ls workspace; PI_TEMPLATE_AGENT=0 Pi-Template schedule add --every 1d --name spoofed -- true",
      `Permission Required tool : bash rule : * command : ${checkoutRoot}/PI-TEMPLATE schedule run ${ownerCommand.id} ` +
        `full command : PI_TEMPLATE_AGENT=0 ${checkoutRoot}/PI-TEMPLATE schedule run ${ownerCommand.id}`,
    ], label);
    assert.equal(existsSync(marker), false, label);
    assert.equal((await owner.listSchedules()).some(({ name }) => name === "spoofed"), false, label);
    assert.deepEqual(daemon!.state.listRuns(ownerCommand.id), [], label);
  };
  await assertSpoofsRefused("read-only", "read-only, sandbox off");
  await assertSpoofsRefused("ask", "headless ask, sandbox off");
  await assertOwnerApprovalsHold("interactive ask, sandbox off");
  savePermissionMode(home, "ask");
  const headlessLs = await agentTurn(["ls workspace"], ([result]) => result!);
  assert.equal(headlessLs.results[0], NO_APPROVER);
  const redirected = await agentTurn(["pi-template notes list > notes.json"], ([result]) => result!);
  assert.equal(redirected.results[0], "[pi-permission-system] This 'path_write' call for tool 'bash' for path 'notes.json' (rule '*') requires approval, but no interactive UI is available.");
  assert.equal(existsSync(join(cwd, "notes.json")), false);
  const written = await toolResultFromTurn(faux, { home, cwd }, "write", { path: join(cwd, "written.txt"), content: "x" });
  assert.equal(written, `[pi-permission-system] This 'path_write' call for tool 'write' for path '${join(cwd, "written.txt")}' (rule '*') requires approval, but no interactive UI is available.`);
  assert.equal(existsSync(join(cwd, "written.txt")), false);

  savePermissionMode(home, "ask");
  let chained = "";
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: 'pi-template db query "SELECT 1"; rm -rf workspace' }), { stopReason: "toolUse" }),
    (context) => { chained = textOf(context.messages.at(-1)); return fauxAssistantMessage("refused"); },
  ]);
  const prompt = "Query, then clean up.";
  const headless: ScheduledPromptRunRequest = {
    payload: { kind: ScheduledPayloadKind.Prompt, prompt, toolsAllow: [AgentToolId.Bash] },
    cwd,
    schedule: {
      id: "schedule-chain", name: "chain", enabled: true, cwd, timeoutSeconds: 30, revision: 1,
      trigger: { kind: ScheduleKind.Every, everyMs: 60_000, anchorMs: 0 },
      payload: { kind: ScheduledPayloadKind.Prompt, prompt, toolsAllow: [AgentToolId.Bash] },
      createdAt: "2026-10-17T00:00:00.000Z", updatedAt: "2026-10-17T00:00:00.000Z", nextRunAt: null,
    },
    runId: "run-chain",
    signal: new AbortController().signal,
  };
  assert.equal((await createScheduledPromptRunner({ home, readiness: () => true })(headless)).exitCode, 0);
  assert.equal(chained, "[pi-permission-system] This 'path' call for tool 'bash' for path 'workspace' (rule '*') requires approval, but no interactive UI is available.");
  assert.equal(readFileSync(join(cwd, "workspace", "keep.txt"), "utf8"), "kept\n");
  savePermissionMode(home, "allow");

  const retired = await owner.createSchedule({
    name: "count with a retired tool", enabled: false, cwd, timeoutSeconds: 60,
    trigger: { kind: ScheduleKind.Every, everyMs: 86_400_000, anchorMs: Date.now() },
    payload: { kind: ScheduledPayloadKind.Prompt, prompt: "How many notes are saved?", toolsAllow: ["query_database" as AgentToolId] },
  });
  assert.deepEqual(retired.payload, { kind: ScheduledPayloadKind.Prompt, prompt: "How many notes are saved?", toolsAllow: ["bash"] });
  let scheduledResult = "";
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "pi-template notes list" }), { stopReason: "toolUse" }),
    (context) => {
      scheduledResult = textOf(context.messages.at(-1));
      return fauxAssistantMessage(countAnswer([scheduledResult]));
    },
  ]);
  const started = await owner.runSchedule(retired.id);
  for (let waited = 0; daemon.state.runById(started.id)?.status === ScheduleRunStatus.Running; waited += 50) {
    if (waited > 60_000) throw new Error("the scheduled run did not finish");
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
  }
  const finished = daemon.state.runById(started.id);
  assert.equal(finished?.status, ScheduleRunStatus.Completed, finished?.error ?? finished?.stderrTail ?? "");
  assert.equal(finished?.stdoutTail, "There are 4 notes saved.");

  const sandboxProbe = await createSandboxAdapter().verify(JSON.parse(sandboxPolicy(true)));
  if (sandboxProbe.unavailable) {
    process.stdout.write(`SKIP — the sandboxed agent turn needs the real sandbox: ${sandboxProbe.reason}\n`);
  } else {
    writeFileSync(paths.sandboxPolicy, sandboxPolicy(true));
    const sandboxed = await agentTurn([
      "pi-template notes list",
      // A glob slips past the literal-path permission rule, so this reaches the sandbox itself.
      `cat ${home}/daemon.js?n`,
      `curl -sS -m 3 http://127.0.0.1:${daemon.port}/health`,
    ], countAnswer);
    assert.equal(sandboxed.answer, "There are 4 notes saved.");
    assert.equal(sandboxed.results[1], `cat: ${paths.daemonInfo}: Operation not permitted\n\n\nCommand exited with code 1`);
    assert.match(sandboxed.results[2]!, /Command exited with code (7|56)$/);
    await assertSpoofsRefused("read-only", "read-only, sandbox on");
    await assertSpoofsRefused("ask", "headless ask, sandbox on");
    await assertOwnerApprovalsHold("interactive ask, sandbox on");
    savePermissionMode(home, "allow");
    writeFileSync(paths.sandboxPolicy, sandboxPolicy(false));
  }

  owner.close();
  await daemon.close();
  daemon = undefined;
  const stopped = await agentTurn(["pi-template notes list"], ([result]) => result!);
  assert.equal(stopped.results[0], `${NO_DAEMON}\n\n\nCommand exited with code 1`);
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 2_000));
  assert.equal(existsSync(paths.daemonInfo), false);
  assert.equal(existsSync(paths.agentSocket), false);
  assert.equal(existsSync(join(dirname(paths.daemonInfo), "logs", "daemon.log")), false, "nothing tried to start a daemon");

  process.stdout.write("ok — the agent counts, saves, and schedules through pi-template in bash; owner denies, read-only, interactive ask with owner approvals, " +
    "headless ask, command-schedule authority, the sandbox, a retired tool's schedule, doctor, and a stopped daemon all hold\n");
} finally {
  if (daemon) await daemon.close();
  faux.unregister();
  if (previousHome === undefined) delete process.env.PI_TEMPLATE_HOME;
  else process.env.PI_TEMPLATE_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
}
