import type { Command } from "commander";
import { emit, verb, withGateway } from "./command";

const ONBOARD_OPTIONS: ReadonlyArray<[string, string]> = [
  ["--non-interactive", "take answers from flags instead of prompts"],
  ["--no-browser", "log in with a device code instead of a local browser callback"],
  ["--provider <id>", "model provider"],
  ["--api-key <key>", "provider API key (or --auth-file)"],
  ["--auth-file <path>", "import credentials from a Pi auth.json"],
  ["--model <id>", "model id for the provider"],
  ["--permission <mode>", "permission mode: allow (default), ask, or read-only"],
  ["--acknowledge-resources", "accept the bundled agent resources"],
  ["--workspace-skills <policy>", "bundled, all, or allowlist (with --skill)"],
  ["--skill <name>", "allowlisted workspace skill (repeatable)"],
  ["--approve-workspace-context", "load the workspace's context files"],
  ["--protected-path <path>", "path the agent must not write (repeatable)"],
  ["--protected-repo <repo>", "repository the agent must not write (repeatable)"],
  ["--sandbox", "turn the sandbox on for bash"],
  ["--sandbox-off", "turn the sandbox off"],
  ["--sandbox-read <path>", "sandbox read root (repeatable; default cwd)"],
  ["--sandbox-write <path>", "sandbox write root (repeatable; default cwd)"],
  ["--network-domain <host>", "sandbox admits this host (repeatable)"],
  ["--service <choice>", "always-on service: installed or declined"],
  ["--executable <path>", "service executable (with --service installed)"],
  ["--working-directory <path>", "service working directory (with --service installed)"],
];

export function addHarnessCommands(program: Command): void {
  verb(program, "status", "daemon health and readiness, no model call", {
    useWhen: "you need to know whether the daemon is running and ready.",
    notFor: "why setup is incomplete: pi-template doctor.",
    examples: ["pi-template status"],
  }, async () => await withGateway(async (client) => {
    await emit({ health: client.probe.health, ready: client.probe.ready });
    return 0;
  }));

  verb(program, "doctor", "check setup: roots, provider, model, resources, permissions, sandbox, service", {
    useWhen: "something does not work and you need to know which part of setup is missing.",
    next: "pi-template onboard to change what doctor reports.",
    rules: ["Exits 1 when any check fails; the report says which."],
    examples: ["pi-template doctor"],
  }, async () => await withGateway(async (client) => {
    const report = await client.doctor() as { ok?: unknown };
    await emit(report);
    return report.ok === true ? 0 : 1;
  }));

  const onboard = verb(program, "onboard", "set up or change the harness: provider, model, resources, permissions, sandbox, service", {
    useWhen: "the owner sets the harness up or revisits a recorded answer.",
    rules: [
      "Interactive by default; --non-interactive takes every answer from flags.",
      "--non-interactive needs --provider, --api-key or --auth-file, --model, --service, and --acknowledge-resources. --permission defaults to allow.",
      "The sandbox stays off unless --sandbox turns it on (--sandbox-off turns it off); its roots default to cwd.",
      "On an onboarded home, every omitted flag keeps its recorded answer; a recorded sandbox choice, permission mode, or protected-path list that cannot be read stops the rerun until its flag replaces it.",
    ],
    examples: [
      "pi-template onboard",
      "pi-template onboard --non-interactive --auth-file ~/.pi/agent/auth.json --provider <id> --model <id> --permission ask --service declined --acknowledge-resources",
    ],
  }, async () => {
    const { onboard: runOnboard } = await import("../onboard");
    const [, , , ...flagsInOrder] = process.argv;
    await emit(await runOnboard(flagsInOrder));
    return 0;
  });
  for (const [flags, help] of ONBOARD_OPTIONS) onboard.option(flags, help);

  verb(program, "prompt <message...>", "one headless turn with the agent: its answer as text, or with --json Pi's event stream", {
    useWhen: "a script or another agent wants one answer from the harness agent.",
    rules: ["Prints the agent's answer, not a JSON payload; --json streams Pi's JSON event log instead."],
    examples: ['pi-template prompt "what can you do?"', 'pi-template prompt --json "what can you do?"'],
  }, async ({ args: [message], options }) => {
    const { requireOnboarded } = await import("../entry");
    requireOnboarded();
    const { runPromptSession } = await import("../interactive");
    return await withGateway(async (client) => await runPromptSession({
      gateway: client,
      message: (message as string[]).join(" "),
      json: options.json === true,
    }));
  }).option("--json", "stream Pi's JSON event log instead of the answer text").allowUnknownOption();

  verb(program, "daemon", "run the daemon in the foreground (other commands start it automatically)", {
    useWhen: "debugging the daemon or running it under a service manager; every other command starts it when needed.",
    examples: ["pi-template daemon"],
  }, async () => {
    const { daemonMain } = await import("../../daemon");
    await daemonMain();
    return 0;
  });
}
