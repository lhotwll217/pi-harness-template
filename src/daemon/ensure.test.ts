import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLaunchdServiceAdapter,
  daemonLaunchAgentPath,
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

  process.stdout.write("ok — launchd installation verifies exact configuration and loaded job\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
