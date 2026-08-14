import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { resolve, normalize } from "node:path";
import type { ProjectResolver } from "./types.ts";

const execFileAsync = promisify(execFile);

export interface GitRunner {
  run(cwd: string): Promise<string | undefined>;
}

export const defaultGitRunner: GitRunner = {
  async run(cwd) {
    try {
      const result = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        timeout: 2_000,
        windowsHide: true,
      });
      return result.stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  },
};

async function canonicalPath(path: string): Promise<string> {
  const resolved = normalize(resolve(path));
  try {
    return normalize(await realpath(resolved));
  } catch {
    return resolved;
  }
}

export class GitProjectResolver implements ProjectResolver {
  private readonly git: GitRunner;

  constructor(git: GitRunner = defaultGitRunner) {
    this.git = git;
  }

  async resolve(cwd: string): Promise<string> {
    const normalizedCwd = await canonicalPath(cwd);
    const gitRoot = await this.git.run(normalizedCwd);
    if (gitRoot) return `git:${await canonicalPath(gitRoot)}`;
    return `cwd:${normalizedCwd}`;
  }
}

export async function resolveProjectKey(
  cwd: string,
  git: GitRunner = defaultGitRunner,
): Promise<string> {
  return new GitProjectResolver(git).resolve(cwd);
}
