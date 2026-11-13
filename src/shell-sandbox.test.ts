import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { runShellTool } from "./pi-tools.js";
import { ProcessSessionManager } from "./process-sessions.js";
import {
  SHELL_SANDBOX_OFF,
  shellSandboxFilesystem,
  type ShellSandboxSettings,
} from "./shell-sandbox.js";

const settings: ShellSandboxSettings = { mode: "workspace", allowRead: [], allowedDomains: [] };
const node = JSON.stringify(process.execPath);

async function sandboxAvailable(): Promise<boolean> {
  const supported = process.platform !== "win32" && SandboxManager.isSupportedPlatform();

  if (!supported || SandboxManager.checkDependencies().errors.length > 0) return false;

  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "devspace-shell-sandbox-probe-")));

  try {
    const response = await runShellTool(
      { command: "true" },
      { cwd: workspace, sandbox: { workspaceRoot: workspace, settings } },
    );

    return !response.isError;
  } catch {
    return false;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

after(async () => {
  await SandboxManager.reset();
});

const skip = (await sandboxAvailable()) ? false : "the OS sandbox is not available on this host";

function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(homedir(), ".devspace-shell-sandbox-")));
  const workspace = join(base, "workspace");
  const outside = join(base, "outside");

  mkdirSync(workspace);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "outside-secret");
  writeFileSync(join(workspace, "inside.txt"), "inside-content");
  t.after(() => rmSync(base, { recursive: true, force: true }));

  return { workspace, outside };
}

type Run = (command: string, workspace: string, cwd?: string) => Promise<string>;

const bash: Run = async (command, workspace, cwd = workspace) => {
  const response = await runShellTool({ command }, { cwd, sandbox: { workspaceRoot: workspace, settings } });

  return response.content.map((content) => (content.type === "text" ? content.text : "")).join("");
};

function execCommand(tty: boolean): Run {
  return async (command, workspace, cwd = workspace) => {
    const sessions = new ProcessSessionManager();

    const snapshot = await sessions.start({
      workspaceId: "sandbox-test",
      command,
      cwd,
      workspaceRoot: workspace,
      sandbox: settings,
      tty,
    });

    sessions.shutdown();

    return snapshot.output;
  };
}

const surfaces: Array<[string, Run]> = [
  ["bash", bash],
  ["exec_command", execCommand(false)],
];

for (const [name, run] of surfaces) {
  test(`${name}: a command cannot read a file outside the workspace`, { skip }, async (t) => {
    const { workspace, outside } = fixture(t);
    const output = await run(`cat ${JSON.stringify(join(outside, "secret.txt"))}; echo status=$?`, workspace);

    assert.doesNotMatch(output, /outside-secret/);
    assert.match(output, /status=1/);
  });

  test(`${name}: a command cannot write a file outside the workspace`, { skip }, async (t) => {
    const { workspace, outside } = fixture(t);
    await run(`echo x > ${JSON.stringify(join(outside, "written.txt"))}`, workspace);

    assert.equal(existsSync(join(outside, "written.txt")), false);
  });

  test(`${name}: changing directory out of the workspace does not help`, { skip }, async (t) => {
    const { workspace, outside } = fixture(t);
    const output = await run("cd ../outside && touch moved.txt; cat secret.txt; echo done", workspace);

    assert.equal(existsSync(join(outside, "moved.txt")), false);
    assert.doesNotMatch(output, /outside-secret/);
  });

  test(`${name}: a script cannot reach outside through a path the command never names`, { skip }, async (t) => {
    const { workspace, outside } = fixture(t);
    const target = JSON.stringify(join(outside, "from-script.txt"));
    const secret = JSON.stringify(join(outside, "secret.txt"));

    writeFileSync(
      join(workspace, "run.cjs"),
      `const fs=require("fs");try{fs.writeFileSync(${target},"x")}catch{}try{console.log(fs.readFileSync(${secret},"utf8"))}catch{console.log("blocked")}`,
    );
    const output = await run(`${node} run.cjs`, workspace);

    assert.equal(existsSync(join(outside, "from-script.txt")), false);
    assert.doesNotMatch(output, /outside-secret/);
    assert.match(output, /blocked/);
  });

  test(`${name}: a symlink inside the workspace does not reach outside`, { skip }, async (t) => {
    const { workspace, outside } = fixture(t);
    symlinkSync(outside, join(workspace, "escape"));
    const output = await run("echo x > escape/linked.txt; cat escape/secret.txt; echo done", workspace);

    assert.equal(existsSync(join(outside, "linked.txt")), false);
    assert.doesNotMatch(output, /outside-secret/);
  });

  test(`${name}: work inside the workspace behaves normally`, { skip }, async (t) => {
    const { workspace } = fixture(t);
    mkdirSync(join(workspace, "sub"));

    const output = await run(
      `cat ../inside.txt && echo made > made.txt && cat made.txt && ${node} -e "console.log(6*7)"`,
      workspace,
      join(workspace, "sub"),
    );

    assert.match(output, /inside-content/);
    assert.match(output, /made/);
    assert.match(output, /42/);
    assert.equal(existsSync(join(workspace, "sub", "made.txt")), true);
  });

  test(`${name}: a command cannot reach a domain that is not allowed`, { skip }, async (t) => {
    const { workspace } = fixture(t);

    const output = await run(
      `${node} -e "fetch('https://example.com').then(()=>console.log('reached')).catch(()=>console.log('blocked'))"`,
      workspace,
    );

    assert.doesNotMatch(output, /reached/);
  });
}

test("exec_command with a terminal is contained too", { skip }, async (t) => {
  const { workspace, outside } = fixture(t);
  const run = execCommand(true);
  const output = await run(`echo x > ${JSON.stringify(join(outside, "tty.txt"))}; echo inside-ok`, workspace);

  assert.equal(existsSync(join(outside, "tty.txt")), false);
  assert.match(output, /inside-ok/);
});

test("with the sandbox off, commands run with the user's full authority", async (t) => {
  const { workspace, outside } = fixture(t);
  const sessions = new ProcessSessionManager();

  const snapshot = await sessions.start({
    workspaceId: "sandbox-off",
    command: `${node} -e "console.log(require('fs').readFileSync(${JSON.stringify(JSON.stringify(join(outside, "secret.txt"))).slice(1, -1)},'utf8'))"`,
    cwd: workspace,
    workspaceRoot: workspace,
    sandbox: SHELL_SANDBOX_OFF,
  });

  sessions.shutdown();
  assert.match(snapshot.output, /outside-secret/);
});

test("a sandboxed command without a workspace root is refused", async () => {
  const sessions = new ProcessSessionManager();

  await assert.rejects(
    sessions.start({ workspaceId: "no-root", command: "echo hi", cwd: tmpdir(), sandbox: settings }),
    /needs a workspace root/,
  );
});

test("the policy writes only the workspace and hides the home directory", (t) => {
  const { workspace } = fixture(t);
  const home = realpathSync(homedir());

  const policy = shellSandboxFilesystem(
    workspace,
    { ...settings, allowRead: [join(home, "extra")] },
    { PATH: `${join(home, ".toolchain", "bin")}:${join(home, "bin")}:/usr/bin` },
  );

  assert.ok(policy.denyRead.includes(home));
  assert.ok(policy.denyRead.includes(join(home, ".ssh")));
  assert.ok(policy.allowRead?.includes(workspace));
  assert.ok(policy.allowRead?.includes(join(home, "extra")));
  assert.ok(policy.allowRead?.includes(join(home, ".toolchain")));
  assert.ok(policy.allowRead?.includes(join(home, "bin")));
  assert.equal(policy.allowRead?.includes(home), false);
  assert.deepEqual(policy.allowWrite.slice(0, 1), [workspace]);
  assert.deepEqual(policy.denyWrite, [join(workspace, ".env"), join(workspace, ".env.local")]);
});
