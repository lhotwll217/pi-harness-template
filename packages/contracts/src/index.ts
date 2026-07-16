// Pi Template — shared contracts.
//
// UI-INDEPENDENT by design: the gateway *produces* this data; every surface (CLI, another
// agent, a script, a product client) *consumes* it. No colors, no layout, no terminal, no
// engine deps. This is the contract the daemon and all clients agree on. Modules here own
// shared types, pure rules, wire shapes, and dependency-light filesystem config readers —
// never the database, network, timers, processes, or model calls (docs/architecture.md).

// The harness home and agent workspace: root layout, owner settings, and the rule that
// entry points create missing harness-owned files but never overwrite owner content.
export {
  DEFAULT_PERMISSION_MODE,
  DEFAULT_SKILL_POLICY,
  DEFAULT_TOOL_POSTURE,
  ensureHarnessWorkspace,
  harnessPaths,
  isPermissionMode,
  loadHarnessSettings,
  saveHarnessSettings,
} from "./harness-home";
export type {
  HarnessPaths,
  HarnessSettings,
  PermissionMode,
  SkillPolicy,
} from "./harness-home";

// Protected paths: owner-declared off-limits trees and repos, consumed by the permission
// layer and by direct tool guards. OS enforcement owns the stronger boundary.
export { isProtected, loadProtectedPaths, pathIdentities } from "./protected-paths";
export type { ProtectedPaths } from "./protected-paths";

// Permission-mode reconciliation into the Pi permission-system config. A permission
// decision is never a sandbox (docs/security.md).
export { reconcilePermissionSettings, savePermissionMode } from "./permissions";
export type {
  PiDenyRule,
  PiPermissionConfig,
  PiPermissionPatternMap,
  PiPermissionState,
} from "./permissions";

// Onboarding stage vocabulary and pure progression rules for the versioned, resumable,
// fail-closed setup flow (docs/onboarding.md).
export {
  ONBOARDING_STAGES,
  ONBOARDING_VERSION,
  isOnboardingComplete,
  nextOnboardingStage,
} from "./onboarding";
export type { OnboardingMarker, OnboardingProgress, OnboardingStage } from "./onboarding";

// Closed scheduler vocabulary shared by clients, state, and the daemon runtime
// (docs/scheduler.md).
export {
  AgentToolId,
  ScheduleKind,
  ScheduledPayloadKind,
  ScheduleRunStatus,
  ScheduleRunTrigger,
} from "./scheduling";
export type {
  ScheduleCreateInput,
  ScheduleDefinition,
  ScheduledCommandPayload,
  ScheduledPromptPayload,
  ScheduledPayload,
  ScheduledPromptRunRequest,
  ScheduledTimeTriggerContext,
  ScheduleExecutionResult,
  ScheduleRun,
  ScheduleTrigger,
  ScheduleTriggerContext,
} from "./scheduling";

// The notes worked example: the template's demonstrative write-to-read record family
// (docs/state-and-sessions.md#worked-example-notes).
export type { Note, NoteCreateInput } from "./notes";

// Typed post-commit domain events and their Gateway invalidation projections. Events tell
// consumers what class of truth changed; consumers refetch current truth.
export { DomainEventKind, GatewayEventKind } from "./events";
export type { DomainEvent, GatewayEvent } from "./events";

// The wire contract: daemon identity, health, readiness, the database query surface, and
// the typed Gateway API every client consumes.
export { DEFAULT_DAEMON_PORT, DatabaseQueryAction } from "./protocol";
export type {
  DaemonHealth,
  DaemonInfo,
  DaemonReady,
  DatabaseQueryRequest,
  DatabaseQueryResponse,
  GatewayApi,
} from "./protocol";

// Deterministic documentation catalog, query results, and lookup failures
// (docs/docs-interface.md).
export type {
  DocsCatalogEntry,
  DocsDocument,
  DocsLookupError,
  DocsQueryField,
  DocsQueryMatch,
  DocsQueryResult,
  DocsSection,
} from "./docs";
