import path from "node:path";

export function resolveGitdir(worktree: string, gitFileBody: string): string | null {
  const line = gitFileBody.split(/\r?\n/).find((entry) => entry.startsWith("gitdir:"));
  if (!line) return null;
  const target = line.slice("gitdir:".length).trim();
  if (!target || target.includes("\0")) return null;
  const api = pathApi(worktree);
  const resolved = api.isAbsolute(target) ? target : api.join(worktree, target);
  return api.normalize(resolved);
}

export function resolveCommondir(gitdir: string, commondirBody: string): string {
  const target = commondirBody.trim();
  const api = pathApi(gitdir);
  const resolved = api.isAbsolute(target) ? target : api.join(gitdir, target);
  return api.normalize(resolved);
}

export async function readGitConfigText(
  readText: (absolutePath: string) => Promise<string | null>,
  worktree: string,
): Promise<string | null> {
  const api = pathApi(worktree);
  const direct = await readText(api.join(worktree, ".git", "config"));
  if (direct !== null) return direct;
  const pointer = await readText(api.join(worktree, ".git"));
  if (pointer === null) return null;
  const gitdir = resolveGitdir(worktree, pointer);
  if (gitdir === null) return null;
  const config = await readText(api.join(gitdir, "config"));
  if (config !== null) return config;
  const common = await readText(api.join(gitdir, "commondir"));
  if (common === null) return null;
  return readText(api.join(resolveCommondir(gitdir, common), "config"));
}

function pathApi(root: string): path.PlatformPath {
  return root.includes("\\") ? path.win32 : path.posix;
}
