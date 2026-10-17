// The agent reaches harness state through the same `pi-template` CLI the owner uses, from
// bash (docs/security.md#the-agent-uses-its-own-cli). Contracts owns the split so the
// permission rules and the CLI registry read one list.

/** Top-level commands the agent may run; each gets a generated bash allow rule in every mode. */
export const AGENT_CLI_COMMANDS = Object.freeze(["db", "docs", "notes", "schedule", "status", "doctor"] as const);

/** Top-level commands only the owner runs: they set the harness up, start it, or start a model turn. */
export const OWNER_CLI_COMMANDS = Object.freeze(["onboard", "daemon", "prompt"] as const);

/** Set to `1` in the agent's bash, so the CLI acts as an agent caller. */
export const AGENT_CALLER_VARIABLE = "PI_TEMPLATE_AGENT";

export const isAgentCaller = (environment: NodeJS.ProcessEnv = process.env): boolean =>
  environment[AGENT_CALLER_VARIABLE] === "1";
