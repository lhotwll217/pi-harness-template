import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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

  process.stdout.write("ok — launchd installation verifies exact configuration and loaded job, and ownership of a pid\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
