import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import {
  SandboxManager,
  type FilesystemConfig,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { terminateProcessTree } from "./process-platform.js";
import { isPathInsideRoot } from "./roots.js";
import {
  USER_NAMESPACE_DENIED_MESSAGE,
  createUserNamespaceDenialDetector,
  protectedHomePaths,
} from "./sandbox-policy.js";

export interface ShellSandboxSettings {
  mode: "workspace" | "off";
  allowRead: string[];
  allowedDomains: string[];
}

export interface ShellSandboxTarget {
  workspaceRoot: string;
  settings: ShellSandboxSettings;
}

export interface WrappedShellCommand {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  release: () => void;
}

export const SHELL_SANDBOX_OFF: ShellSandboxSettings = { mode: "off", allowRead: [], allowedDomains: [] };

let initialization: Promise<void> | undefined;

export function isShellSandboxed(target: ShellSandboxTarget | undefined): target is ShellSandboxTarget {
  return target?.settings.mode === "workspace";
}

export function shellSandboxFilesystem(
  workspaceRoot: string,
  settings: ShellSandboxSettings,
  environment: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): FilesystemConfig {
  const root = canonical(workspaceRoot);
  const canonicalHome = canonical(home);
  const gitDirectory = linkedGitDirectory(root);
  const temporary = canonical(tmpdir());

  return {
    denyRead: [canonicalHome, ...protectedHomePaths(canonicalHome)],
    allowRead: unique([
      root,
      ...(gitDirectory ? [gitDirectory] : []),
      join(canonicalHome, ".gitconfig"),
      join(canonicalHome, ".config", "git"),
      ...toolchainPaths(environment, canonicalHome),
      ...settings.allowRead.map(canonical),
    ]),
    allowWrite: unique([root, temporary, ...(gitDirectory ? [gitDirectory] : [])]),
    denyWrite: [join(root, ".env"), join(root, ".env.local")],
  };
}

export async function wrapShellCommand(
  command: string,
  cwd: string,
  target: ShellSandboxTarget,
  options: { pty?: boolean; signal?: AbortSignal } = {},
): Promise<WrappedShellCommand> {
  await ensureInitialized(target.settings);

  const customConfig: Partial<SandboxRuntimeConfig> = {
    filesystem: shellSandboxFilesystem(target.workspaceRoot, target.settings),
    network: networkConfig(target.settings),
  };

  if (options.pty) customConfig.allowPty = true;

  const wrapped = await SandboxManager.wrapWithSandboxArgv(command, undefined, customConfig, options.signal, cwd);
  const [executable, ...args] = wrapped.argv;

  if (!executable) throw new Error("The shell sandbox returned an empty command.");

  return { executable, args, env: wrapped.env, release: () => SandboxManager.cleanupAfterCommand() };
}

export function createShellSandboxBashOperations(target: ShellSandboxTarget): BashOperations {
  return {
    exec: async (command, cwd, options) => {
      if (options.signal?.aborted) throw new Error("aborted");

      const wrapped = await wrapShellCommand(command, cwd, target, optionalSignal(options.signal));
      const denial = createUserNamespaceDenialDetector();

      try {
        const result = await runWrapped(wrapped, cwd, {
          ...options,
          onData: (data) => {
            denial.push(data.toString("utf8"));
            options.onData(data);
          },
        });

        if (denial.denied && result.exitCode !== 0) throw new Error(USER_NAMESPACE_DENIED_MESSAGE);

        return result;
      } finally {
        wrapped.release();
      }
    },
  };
}

async function ensureInitialized(settings: ShellSandboxSettings): Promise<void> {
  if (process.platform === "win32" || !SandboxManager.isSupportedPlatform()) {
    throw new Error(
      `shell.sandbox is "workspace", but the shell sandbox does not support ${process.platform}. ` +
        "Commands are not run without it; set shell.sandbox to \"off\" to run them uncontained.",
    );
  }

  if (!initialization) {
    initialization = SandboxManager.initialize({
      network: networkConfig(settings),
      filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
    }).catch((error) => {
      initialization = undefined;
      throw new Error(
        `The shell sandbox could not initialize: ${error instanceof Error ? error.message : String(error)}. ` +
          "Commands are not run without it; set shell.sandbox to \"off\" to run them uncontained.",
      );
    });
  }

  await initialization;
}

function networkConfig(settings: ShellSandboxSettings): SandboxRuntimeConfig["network"] {
  return { allowedDomains: [...settings.allowedDomains], deniedDomains: [], strictAllowlist: true };
}

function runWrapped(
  wrapped: WrappedShellCommand,
  cwd: string,
  options: Parameters<BashOperations["exec"]>[2],
): Promise<{ exitCode: number | null }> {
  return new Promise((resolveResult, reject) => {
    const detached = process.platform !== "win32";

    const child = spawn(wrapped.executable, wrapped.args, {
      cwd,
      env: { ...wrapped.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached,
      shell: false,
      windowsHide: true,
    });

    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const kill = () => terminateProcessTree(child, "SIGKILL", detached);

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;

      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", kill);
      callback();
    };

    options.signal?.addEventListener("abort", kill, { once: true });

    if (options.timeout !== undefined && options.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, options.timeout * 1000);
    }

    child.stdout?.on("data", options.onData);
    child.stderr?.on("data", options.onData);
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (exitCode) => {
      finish(() => {
        if (options.signal?.aborted) reject(new Error("aborted"));
        else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
        else resolveResult({ exitCode });
      });
    });
  });
}

function toolchainPaths(environment: NodeJS.ProcessEnv, home: string): string[] {
  const entries = (environment.PATH ?? "").split(delimiter).filter((entry) => isAbsolute(entry));

  return entries.flatMap((entry) => {
    const directory = canonical(entry);

    if (directory === home || !isPathInsideRoot(directory, home)) return [];
    const parent = dirname(directory);

    return [parent === home ? directory : parent];
  });
}

function linkedGitDirectory(root: string): string | undefined {
  const dotGit = join(root, ".git");

  try {
    if (!statSync(dotGit).isFile()) return undefined;
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));

    if (!match?.[1]) return undefined;
    const gitDirectory = resolve(root, match[1].trim());
    const commonFile = join(gitDirectory, "commondir");

    if (!existsSync(commonFile)) return canonical(gitDirectory);

    return canonical(resolve(gitDirectory, readFileSync(commonFile, "utf8").trim()));
  } catch {
    return undefined;
  }
}

function canonical(path: string): string {
  const absolute = resolve(path);

  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function unique(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

function optionalSignal(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal ? { signal } : {};
}
