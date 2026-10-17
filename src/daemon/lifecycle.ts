import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DAEMON_PROBE_TIMEOUT_MS,
  DomainEventKind,
  GatewayEventKind,
  ensureHarnessWorkspace,
  harnessPaths,
  isOnboardingComplete,
  type DaemonHealth,
  type DaemonInfo,
  type DaemonReady,
  type DomainEvent,
  type GatewayEvent,
  type OnboardingMarker,
} from "@pi-template/contracts";
import { createChatService, createScheduledPromptRunner, runDoctor } from "../agent";
import { createDocsCatalog } from "../docs-catalog/docs-catalog";
import { startGateway, type RunningGateway } from "../gateway/server";
import { Scheduler, type SchedulerOptions } from "../scheduler";
import { State, describeTable, listTables, runQuery } from "../state";
import { createWorkspaceFiles } from "../workspace/files";
import { runtimeFingerprint } from "./fingerprint";

export interface DaemonOptions {
  port?: number;
  dbPath?: string;
  repositoryRoot?: string;
  fingerprintIntervalMs?: number;
  onStale?: () => void;
  scheduler?: SchedulerOptions;
  /** Test composition seam for instrumenting the one durable writer. */
  stateFactory?: (dbPath: string) => State;
}

export interface RunningDaemon {
  port: number;
  fingerprint: string;
  state: State;
  scheduler: Scheduler;
  close(): Promise<void>;
}

function onboardingMarker(path: string): OnboardingMarker | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as OnboardingMarker; } catch { return undefined; }
}

export function gatewayEvent(event: DomainEvent): GatewayEvent {
  switch (event.kind) {
    case DomainEventKind.NoteChanged: return { kind: GatewayEventKind.NotesChanged };
    case DomainEventKind.ScheduleChanged: return { kind: GatewayEventKind.ScheduleChanged };
    case DomainEventKind.ScheduleRunChanged: return { kind: GatewayEventKind.ScheduleRunChanged };
    case DomainEventKind.ChatChanged: return { kind: GatewayEventKind.ChatChanged, chatId: event.chatId };
    case DomainEventKind.WorkspaceChanged: return { kind: GatewayEventKind.WorkspaceChanged };
  }
}

const defaultRepositoryRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function liveDaemon(infoPath: string): Promise<DaemonInfo | undefined> {
  let info: DaemonInfo;
  try { info = JSON.parse(readFileSync(infoPath, "utf8")) as DaemonInfo; } catch { return undefined; }
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/health`, {
      headers: { authorization: `Bearer ${info.authToken}` },
      signal: AbortSignal.timeout(DAEMON_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const health = await response.json() as DaemonHealth;
    return health.pid === info.pid && health.fingerprint === info.fingerprint ? info : undefined;
  } catch {
    return undefined;
  }
}

function daemonAlreadyRunning(info: DaemonInfo): NodeJS.ErrnoException {
  const error = new Error(`pi-template daemon is already running on port ${info.port}`) as NodeJS.ErrnoException;
  error.code = "EADDRINUSE";
  return error;
}

export async function startDaemon(options: DaemonOptions = {}): Promise<RunningDaemon> {
  ensureHarnessWorkspace();
  const paths = harnessPaths();
  const existingDaemon = await liveDaemon(paths.daemonInfo);
  if (existingDaemon) throw daemonAlreadyRunning(existingDaemon);
  const dbPath = options.dbPath ?? paths.stateDb;
  const repoRoot = options.repositoryRoot ?? defaultRepositoryRoot();
  const startedAt = new Date().toISOString();
  const fingerprint = runtimeFingerprint();
  const authToken = randomBytes(32).toString("base64url");
  let stale = false;
  let closed = false;
  let gatewayPort = 0;
  let gateway: RunningGateway | undefined;
  let writtenInfo: DaemonInfo | undefined;
  let discoveryTemporary: string | undefined;
  const modules: DaemonReady["modules"] = {
    state: false,
    scheduler: false,
    gateway: false,
  };

  const state = options.stateFactory?.(dbPath) ?? new State(dbPath);
  modules.state = true;
  const query = {
    listTables: () => listTables(dbPath),
    describeTable: (table: string) => describeTable(table, dbPath),
    runQuery: (sql: string) => runQuery(sql, dbPath),
  };
  let scheduler: Scheduler;
  let docs: ReturnType<typeof createDocsCatalog>;
  try {
    scheduler = new Scheduler(state, {
      ...options.scheduler,
      promptRunner: options.scheduler?.promptRunner ?? createScheduledPromptRunner({ home: paths.home }),
    });
    docs = createDocsCatalog(repoRoot);
  } catch (error) {
    state.close();
    throw error;
  }
  modules.scheduler = true;
  const publish = (event: DomainEvent): void => state.bus.publish(event);
  const chats = createChatService({ home: paths.home, publish });
  const workspace = createWorkspaceFiles({ root: paths.workspace, onWrite: () => publish({ kind: DomainEventKind.WorkspaceChanged }) });
  let schedulerStarted = false;
  const startSchedulerWhenAllowed = (): void => {
    if (closed || schedulerStarted || !isOnboardingComplete(onboardingMarker(paths.onboardingMarker))) return;
    scheduler.start();
    schedulerStarted = true;
  };

  const health = (): DaemonHealth => ({
    ok: true,
    port: gatewayPort,
    pid: process.pid,
    startedAt,
    fingerprint,
    stale,
    repoRoot,
  });
  const ready = (): DaemonReady => {
    const setupRequired = !isOnboardingComplete(onboardingMarker(paths.onboardingMarker));
    if (!setupRequired) startSchedulerWhenAllowed();
    return {
      ready: Object.values(modules).every(Boolean) && !stale,
      setupRequired,
      modules: { ...modules },
    };
  };
  const removeOwnDiscovery = (): void => {
    if (!writtenInfo) return;
    try {
      const current = JSON.parse(readFileSync(paths.daemonInfo, "utf8")) as DaemonInfo;
      if (
        current.pid === writtenInfo.pid &&
        current.startedAt === writtenInfo.startedAt &&
        current.fingerprint === writtenInfo.fingerprint &&
        current.authToken === writtenInfo.authToken
      ) {
        rmSync(paths.daemonInfo, { force: true });
      }
    } catch {
      // Discovery is already absent or belongs to no readable daemon record.
    }
  };

  try {
    gateway = await startGateway({
      authToken,
      health,
      ready,
      port: options.port,
      agentSocket: paths.agentSocket,
      notes: {
        list: () => state.listNotes(),
        create: (input) => state.createNote(input),
        delete: (id) => state.deleteNote(id),
      },
      schedules: {
        list: () => scheduler.list(),
        create: (input) => scheduler.add(input),
        update: (id, input, authorize) => {
          const current = state.scheduleById(id);
          if (!current) throw new Error(`no such schedule: ${id}`);
          authorize?.(current);
          return scheduler.update(id, input, current.revision);
        },
        delete: (id) => scheduler.remove(id),
        run: (id, authorize) => {
          const current = state.scheduleById(id);
          if (current) authorize?.(current);
          return scheduler.run(id);
        },
        runById: (id) => state.runById(id),
      },
      query,
      docs,
      chats,
      workspace,
      events: {
        subscribe: (listener) => state.bus.subscribe((event) => listener(gatewayEvent(event))),
      },
      diagnostics: { doctor: () => runDoctor({ home: paths.home, agentSocketProblem: gateway?.agentSocketProblem }) },
    });
    gatewayPort = gateway.port;
    modules.gateway = true;
    if (gateway.agentSocketProblem) process.stderr.write(`pi-template: ${gateway.agentSocketProblem}; pi-template doctor reports the agent CLI unreachable\n`);

    const info: DaemonInfo = {
      port: gateway.port,
      pid: process.pid,
      startedAt,
      fingerprint,
      authToken,
    };
    mkdirSync(dirname(paths.daemonInfo), { recursive: true });
    discoveryTemporary = `${paths.daemonInfo}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(discoveryTemporary, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
    chmodSync(discoveryTemporary, 0o600);
    renameSync(discoveryTemporary, paths.daemonInfo);
    discoveryTemporary = undefined;
    writtenInfo = info;
    startSchedulerWhenAllowed();
  } catch (error) {
    await gateway?.close().catch(() => undefined);
    await scheduler.stop().catch(() => undefined);
    state.close();
    if (discoveryTemporary) {
      try { rmSync(discoveryTemporary, { force: true }); } catch { /* best effort */ }
    }
    removeOwnDiscovery();
    throw error;
  }

  const fingerprintTimer = setInterval(() => {
    startSchedulerWhenAllowed();
    if (!stale && runtimeFingerprint() !== fingerprint) {
      stale = true;
      options.onStale?.();
    }
  }, options.fingerprintIntervalMs ?? 2_000);
  fingerprintTimer.unref?.();

  return {
    port: gateway.port,
    fingerprint,
    state,
    scheduler,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(fingerprintTimer);
      let schedulerError: unknown;
      try {
        try {
          await chats.stop();
          await scheduler.stop();
        } catch (error) {
          schedulerError = error;
        }
        await gateway.close();
      } finally {
        state.close();
        removeOwnDiscovery();
      }
      if (schedulerError) throw schedulerError;
    },
  };
}

export async function daemonMain(): Promise<number> {
  let daemon: RunningDaemon;
  try {
    daemon = await startDaemon({ onStale: () => process.kill(process.pid, "SIGTERM") });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      process.stderr.write("pi-template: another daemon already owns the loopback port\n");
      return 1;
    }
    throw error;
  }
  process.stderr.write(`pi-template daemon ready at http://127.0.0.1:${daemon.port} · pid ${process.pid}\n`);
  await new Promise<void>((resolve, reject) => {
    const stop = (): void => { void daemon.close().then(resolve, reject); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
