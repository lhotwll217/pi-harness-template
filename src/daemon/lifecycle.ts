import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DomainEventKind,
  GatewayEventKind,
  ensureHarnessWorkspace,
  harnessPaths,
  isOnboardingComplete,
  type DaemonHealth,
  type DaemonInfo,
  type DaemonReady,
  type GatewayEvent,
  type OnboardingMarker,
} from "@pi-template/contracts";
import { createScheduledPromptRunner, runDoctor, type CatalogToolDependencies } from "../agent";
import { createDocsCatalog } from "../docs-catalog/docs-catalog";
import { startGateway, type RunningGateway } from "../gateway/server";
import { Scheduler, type SchedulerOptions } from "../scheduler";
import { State, describeTable, listTables, runQuery } from "../state";
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
  toolDependencies: CatalogToolDependencies;
  close(): Promise<void>;
}

function onboardingMarker(path: string): OnboardingMarker | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as OnboardingMarker; } catch { return undefined; }
}

function gatewayEvent(kind: DomainEventKind): GatewayEvent {
  if (kind === DomainEventKind.NoteChanged) return { kind: GatewayEventKind.NotesChanged };
  if (kind === DomainEventKind.ScheduleChanged) return { kind: GatewayEventKind.ScheduleChanged };
  return { kind: GatewayEventKind.ScheduleRunChanged };
}

const defaultRepositoryRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function liveDaemon(infoPath: string): Promise<DaemonInfo | undefined> {
  let info: DaemonInfo;
  try { info = JSON.parse(readFileSync(infoPath, "utf8")) as DaemonInfo; } catch { return undefined; }
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/health`, {
      headers: { authorization: `Bearer ${info.authToken}` },
      signal: AbortSignal.timeout(1_000),
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
  const toolDependencies: CatalogToolDependencies = { query, notes: state };
  let scheduler: Scheduler;
  let docs: ReturnType<typeof createDocsCatalog>;
  try {
    scheduler = new Scheduler(state, {
      ...options.scheduler,
      promptRunner: options.scheduler?.promptRunner ?? createScheduledPromptRunner({
        home: paths.home,
        resources: toolDependencies,
      }),
    });
    docs = createDocsCatalog(options.repositoryRoot ?? defaultRepositoryRoot());
  } catch (error) {
    state.close();
    throw error;
  }
  modules.scheduler = true;
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
      notes: {
        list: () => state.listNotes(),
        create: (input) => state.createNote(input),
        delete: (id) => state.deleteNote(id),
      },
      schedules: {
        list: () => scheduler.list(),
        create: (input) => scheduler.add(input),
        update: (id, input) => {
          const current = scheduler.list().find((schedule) => schedule.id === id);
          if (!current) throw new Error(`no such schedule: ${id}`);
          return scheduler.update(id, input, current.revision);
        },
        delete: (id) => scheduler.remove(id),
        run: (id) => scheduler.run(id),
      },
      query,
      docs,
      events: {
        subscribe: (listener) => state.bus.subscribe((event) => listener(gatewayEvent(event.kind))),
      },
      diagnostics: { doctor: () => runDoctor({ home: paths.home }) },
    });
    gatewayPort = gateway.port;
    modules.gateway = true;

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
    toolDependencies,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(fingerprintTimer);
      let schedulerError: unknown;
      try {
        try {
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

export async function daemonMain(): Promise<void> {
  let daemon: RunningDaemon;
  try {
    daemon = await startDaemon({ onStale: () => process.kill(process.pid, "SIGTERM") });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      process.stderr.write("pi-template: another daemon already owns the loopback port\n");
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  process.stderr.write(`pi-template daemon ready at http://127.0.0.1:${daemon.port} · pid ${process.pid}\n`);
  await new Promise<void>((resolve, reject) => {
    const stop = (): void => { void daemon.close().then(resolve, reject); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
