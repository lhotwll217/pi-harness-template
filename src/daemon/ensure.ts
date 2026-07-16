import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
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

export interface LaunchdServiceOptions {
  platform?: NodeJS.Platform;
  userHome?: string;
  execFile?: (file: string, args: string[]) => Promise<unknown>;
}

const escapeXml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

export const daemonLaunchAgentPath = (userHome = homedir()): string =>
  join(userHome, "Library", "LaunchAgents", `${DAEMON_LAUNCHD_LABEL}.plist`);

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
  const execFile = options.execFile ?? (async (file, args) => await promisify(execFileCallback)(file, args));
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
      await execFile("launchctl", ["bootout", domain, plist]).catch(() => undefined);
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
