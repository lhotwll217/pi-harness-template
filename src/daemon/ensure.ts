import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

export const DAEMON_LAUNCHD_LABEL = "com.pi-template.daemon";

export interface DaemonServiceConfiguration {
  home: string;
  executable: string;
  workingDirectory: string;
}

export interface DaemonServiceAdapter {
  configure(choice: "installed" | "declined", configuration?: DaemonServiceConfiguration): Promise<void>;
  verify(choice: "installed" | "declined"): Promise<boolean>;
}

export enum LaunchdOwnership {
  Owned = "owned",
  NotOwned = "not-owned",
  Unknown = "unknown",
}

export interface LaunchdServiceOptions {
  platform?: NodeJS.Platform;
  userHome?: string;
  execFile?: (file: string, args: string[], timeoutMs?: number) => Promise<unknown>;
}

// Matches the sandbox probe's bound (src/agent/sandbox/anthropic-sandbox.ts); launchctl answers in milliseconds.
const LAUNCHCTL_TIMEOUT_MS = 5_000;
// The daemon has no shutdown bound of its own (a draining scheduler waits out each run's timeout), so
// the plist's ExitTimeOut bounds it: launchd sends SIGKILL this long after SIGTERM. 5 s is launchd's
// default for user agents as `launchctl print` reports it; the plist pins it.
const DAEMON_EXIT_TIMEOUT_SECONDS = 5;
// bootout returns only after the job exits.
const BOOTOUT_TIMEOUT_MS = DAEMON_EXIT_TIMEOUT_SECONDS * 1_000 + LAUNCHCTL_TIMEOUT_MS;
const execFileAsync = async (file: string, args: string[], timeoutMs = LAUNCHCTL_TIMEOUT_MS): Promise<{ stdout: string }> =>
  await promisify(execFileCallback)(file, args, { timeout: timeoutMs });
const LAUNCHCTL_NOT_LOADED_CODES = new Set<string | number>([3, 113]);
const launchctlReportsNotLoaded = (error: unknown): boolean => {
  const code = (error as { code?: string | number }).code;
  return code !== undefined && LAUNCHCTL_NOT_LOADED_CODES.has(code);
};

const escapeXml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");
const unescapeXml = (value: string): string => value
  .replaceAll("&apos;", "'")
  .replaceAll("&quot;", '"')
  .replaceAll("&gt;", ">")
  .replaceAll("&lt;", "<")
  .replaceAll("&amp;", "&");

const canonicalPath = (path: string): string => {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
};

export const daemonLaunchAgentPath = (userHome = homedir()): string =>
  join(userHome, "Library", "LaunchAgents", `${DAEMON_LAUNCHD_LABEL}.plist`);

const LAUNCH_AGENT_HOME_ENTRY = /<key>PI_TEMPLATE_HOME<\/key>\s*<string>([^<]*)<\/string>/;

export function daemonLaunchAgent(configuration: DaemonServiceConfiguration): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${DAEMON_LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${escapeXml(configuration.executable)}</string><string>daemon</string></array>
  <key>WorkingDirectory</key><string>${escapeXml(configuration.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>PI_TEMPLATE_HOME</key><string>${escapeXml(configuration.home)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ExitTimeOut</key><integer>${DAEMON_EXIT_TIMEOUT_SECONDS}</integer>
  <key>StandardOutPath</key><string>${escapeXml(join(configuration.home, "logs", "daemon.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(configuration.home, "logs", "daemon.log"))}</string>
</dict>
</plist>
`;
}

export function createLaunchdServiceAdapter(options: LaunchdServiceOptions = {}): DaemonServiceAdapter {
  const platform = options.platform ?? process.platform;
  const userHome = options.userHome ?? homedir();
  const plist = daemonLaunchAgentPath(userHome);
  const execFile = options.execFile ?? execFileAsync;
  let expectedPlist: string | undefined;
  return {
    async configure(choice, configuration) {
      if (choice === "declined") return;
      if (platform !== "darwin") throw new Error("launchd service installation is supported only on macOS");
      if (!configuration) throw new Error("daemon service installation requires configuration");
      if (!isAbsolute(configuration.executable) || !isAbsolute(configuration.workingDirectory)) {
        throw new Error("daemon executable and working directory must be absolute paths");
      }
      mkdirSync(dirname(plist), { recursive: true });
      mkdirSync(join(configuration.home, "logs"), { recursive: true });
      expectedPlist = daemonLaunchAgent(configuration);
      writeFileSync(plist, expectedPlist);
      const uid = process.getuid?.();
      if (uid === undefined) throw new Error("launchd service installation requires a Unix user id");
      const domain = `gui/${uid}`;
      await execFile("launchctl", ["bootout", domain, plist], BOOTOUT_TIMEOUT_MS).catch((error: unknown) => {
        // A job that is not loaded fails bootout harmlessly; any other failure surfaces at bootstrap.
        if (!(error as { killed?: boolean }).killed) return;
        throw new Error(
          `launchctl bootout did not finish within ${BOOTOUT_TIMEOUT_MS / 1_000}s while stopping the running daemon; ` +
            "wait for it to exit, then retry",
          { cause: error },
        );
      });
      await execFile("launchctl", ["bootstrap", domain, plist]);
      await execFile("launchctl", ["enable", `${domain}/${DAEMON_LAUNCHD_LABEL}`]);
      await execFile("launchctl", ["kickstart", "-k", `${domain}/${DAEMON_LAUNCHD_LABEL}`]);
    },
    async verify(choice) {
      if (choice === "declined") return true;
      if (platform !== "darwin" || !existsSync(plist)) return false;
      if (expectedPlist && readFileSync(plist, "utf8") !== expectedPlist) return false;
      const uid = process.getuid?.();
      if (uid === undefined) return false;
      try {
        await execFile("launchctl", ["print", `gui/${uid}/${DAEMON_LAUNCHD_LABEL}`]);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function launchdManagesHome(home: string, userHome = homedir()): boolean {
  let entry: string | undefined;
  try {
    entry = LAUNCH_AGENT_HOME_ENTRY.exec(readFileSync(daemonLaunchAgentPath(userHome), "utf8"))?.[1];
  } catch {
    return false;
  }
  return entry !== undefined && canonicalPath(unescapeXml(entry)) === canonicalPath(home);
}

const launchdTarget = (uid: number): string => `gui/${uid}/${DAEMON_LAUNCHD_LABEL}`;
const reportedPid = (printed: { stdout?: unknown } | undefined): number | undefined => {
  const pid = /^\s*pid\s*=\s*(\d+)\s*$/m.exec(String(printed?.stdout ?? ""))?.[1];
  return pid === undefined ? undefined : Number(pid);
};

/** The pid launchd reports for the daemon job, or undefined when it reports none or cannot be asked. */
export async function launchdJobPid(): Promise<number | undefined> {
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  try {
    return reportedPid(await execFileAsync("launchctl", ["print", launchdTarget(uid)]));
  } catch {
    return undefined;
  }
}

// Called only when discovery is absent or stale, so a job launchd is already running is left alone:
// KeepAlive or a concurrent command may have just started it, and its record is about to appear.
export async function startDaemonService(): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("the installed daemon LaunchAgent requires a Unix user id");
  const domain = `gui/${uid}`;
  const target = launchdTarget(uid);
  await execFileAsync("launchctl", ["enable", target]);
  try {
    await execFileAsync("launchctl", ["kickstart", target]);
  } catch (error) {
    if (!launchctlReportsNotLoaded(error)) throw error;
    try {
      await execFileAsync("launchctl", ["bootstrap", domain, daemonLaunchAgentPath()]);
    } catch (bootstrapError) {
      // A concurrent command can bootstrap the job between this kickstart and bootstrap.
      const loaded = await execFileAsync("launchctl", ["print", target]).then(() => true, () => false);
      if (!loaded) throw bootstrapError;
    }
    await execFileAsync("launchctl", ["kickstart", target]);
  }
}

export async function launchdOwnership(
  pid: number,
  home: string,
  options: Omit<LaunchdServiceOptions, "platform"> = {},
): Promise<LaunchdOwnership> {
  if (!launchdManagesHome(home, options.userHome)) return LaunchdOwnership.NotOwned;
  const uid = process.getuid?.();
  if (uid === undefined) return LaunchdOwnership.Unknown;
  const execFile = options.execFile ?? execFileAsync;
  try {
    const reported = reportedPid(await execFile("launchctl", ["print", launchdTarget(uid)]) as { stdout?: unknown });
    if (reported === undefined) return LaunchdOwnership.Unknown;
    return reported === pid ? LaunchdOwnership.Owned : LaunchdOwnership.NotOwned;
  } catch (error) {
    return launchctlReportsNotLoaded(error) ? LaunchdOwnership.NotOwned : LaunchdOwnership.Unknown;
  }
}
