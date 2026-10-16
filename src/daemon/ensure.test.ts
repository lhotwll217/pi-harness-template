import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_EXIT_TIMEOUT_SECONDS,
  LaunchdOwnership,
  createLaunchdServiceAdapter,
  daemonLaunchAgent,
  daemonLaunchAgentPath,
  launchdManagesHome,
  launchdOwnership,
} from "./ensure";

const root = mkdtempSync(join(tmpdir(), "pi-template-launchd-"));
const calls: Array<{ file: string; args: string[] }> = [];

try {
  const service = createLaunchdServiceAdapter({
    platform: "darwin",
    userHome: root,
    execFile: async (file, args) => { calls.push({ file, args }); },
  });
  await service.configure("installed", {
    home: join(root, "harness&home"),
    executable: "/install/pi-template",
    workingDirectory: "/install",
  });
  assert.equal(await service.verify("installed"), true);
  const plistPath = daemonLaunchAgentPath(root);
  const plist = readFileSync(plistPath, "utf8");
  assert.match(plist, /com\.pi-template\.daemon/);
  assert.match(plist, /harness&amp;home/);
  assert.ok(calls.some(({ args }) => args[0] === "print" && args[1]?.includes("com.pi-template.daemon")));

  const home = join(root, "harness&home");
  const printing = (stdout: string) => ({ userHome: root, execFile: async () => ({ stdout }) });
  assert.equal(await launchdOwnership(4242, home, printing("\tpid = 4242\n")), LaunchdOwnership.Owned);
  assert.equal(await launchdOwnership(4242, home, printing("\tpid = 5151\n")), LaunchdOwnership.NotOwned);
  assert.equal(await launchdOwnership(4242, home, printing("\tstate = not running\n")), LaunchdOwnership.Unknown);
  assert.equal(await launchdOwnership(4242, join(root, "other-home"), printing("\tpid = 4242\n")), LaunchdOwnership.NotOwned);
  const failing = (code: number) => ({
    userHome: root,
    execFile: async () => { throw Object.assign(new Error("launchctl failed"), { code }); },
  });
  assert.equal(await launchdOwnership(4242, home, failing(113)), LaunchdOwnership.NotOwned);
  assert.equal(await launchdOwnership(4242, home, failing(1)), LaunchdOwnership.Unknown);

  writeFileSync(plistPath, "stale configuration");
  assert.equal(await service.verify("installed"), false);
  assert.equal(await service.verify("declined"), true);

  const unsupported = createLaunchdServiceAdapter({ platform: "linux", userHome: root });
  await assert.rejects(
    unsupported.configure("installed", {
      home: root,
      executable: "/install/pi-template",
      workingDirectory: "/install",
    }),
    /macOS/,
  );

  assert.equal(await launchdOwnership(4242, home, printing("\tpid = 4242\n")), LaunchdOwnership.NotOwned);

  const realHome = join(realpathSync(root), "real-harness");
  const linkedHome = join(root, "linked-harness");
  mkdirSync(realHome);
  symlinkSync(realHome, linkedHome);
  writeFileSync(plistPath, daemonLaunchAgent({
    home: `${linkedHome}/`,
    executable: "/install/pi-template",
    workingDirectory: "/install",
  }));
  for (const spelling of [realHome, `${realHome}/`, linkedHome, join(root, "linked-harness", "..", "real-harness")]) {
    assert.equal(launchdManagesHome(spelling, root), true, `${spelling} names the LaunchAgent's home`);
    assert.equal(await launchdOwnership(4242, spelling, printing("\tpid = 4242\n")), LaunchdOwnership.Owned);
  }
  assert.equal(launchdManagesHome(join(root, "harness&home"), root), false);

  const entityHome = join(realpathSync(root), "home&<with>entities");
  mkdirSync(entityHome);
  writeFileSync(plistPath, daemonLaunchAgent({ home: entityHome, executable: "/install/pi-template", workingDirectory: "/install" }));
  assert.equal(launchdManagesHome(entityHome, root), true, "XML entities in the plist's home entry are decoded");
  writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
\t\t<key>PI_TEMPLATE_HOME</key>
\t\t<string>${entityHome.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</string>
\t</dict>
\t<key>Label</key>
\t<string>com.pi-template.daemon</string>
</dict>
</plist>
`);
  assert.equal(launchdManagesHome(entityHome, root), true, "a plist reformatted by plutil still names its home");

  const timedOutBootout = createLaunchdServiceAdapter({
    platform: "darwin",
    userHome: root,
    execFile: async (_file, args) => {
      if (args[0] === "bootout") throw Object.assign(new Error("Command failed: launchctl bootout"), { killed: true, signal: "SIGTERM" });
    },
  });
  await assert.rejects(
    timedOutBootout.configure("installed", { home: entityHome, executable: "/install/pi-template", workingDirectory: "/install" }),
    { message: "launchctl bootout did not finish within 10s while stopping the running daemon; wait for it to exit, then retry" },
  );

  const bin = join(root, "bin");
  const launchctlLog = join(root, "launchctl.log");
  mkdirSync(bin);
  const launchctlStoppingAJobThatUsesItsWholeExitTimeOut = `#!/bin/sh
echo "$1" >> "${launchctlLog}"
case "$1" in
  bootout) touch "${root}/booting-out"; sleep ${DAEMON_EXIT_TIMEOUT_SECONDS + 0.5}; rm "${root}/booting-out" ;;
  bootstrap) [ -e "${root}/booting-out" ] && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; } ;;
esac
exit 0
`;
  writeFileSync(join(bin, "launchctl"), launchctlStoppingAJobThatUsesItsWholeExitTimeOut);
  chmodSync(join(bin, "launchctl"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ""}`;
  try {
    await createLaunchdServiceAdapter({ platform: "darwin", userHome: root })
      .configure("installed", { home: entityHome, executable: "/install/pi-template", workingDirectory: "/install" });
  } finally {
    process.env.PATH = path;
  }
  assert.deepEqual(readFileSync(launchctlLog, "utf8").split("\n").filter(Boolean), ["bootout", "bootstrap", "enable", "kickstart"]);
  assert.match(readFileSync(plistPath, "utf8"), /<key>ExitTimeOut<\/key><integer>5<\/integer>/);

  process.stdout.write("ok — launchd installation verifies exact configuration and loaded job, and ownership of a pid\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
