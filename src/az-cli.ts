import { access } from "node:fs/promises";
import { execFile } from "node:child_process";

export interface AzDefaults {
  organization: string;
  project: string;
}

export interface AzCommandResult {
  stdout: string;
  stderr: string;
}

export type AzRunner = (args: readonly string[], signal: AbortSignal) => Promise<AzCommandResult>;

const DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";

export function parseAzDevopsDefaults(text: string): AzDefaults | null {
  let organization = "";
  let project = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const org = /^organization\s*=\s*(.+)$/i.exec(line);
    const proj = /^project\s*=\s*(.+)$/i.exec(line);
    if (org?.[1]) organization = organizationName(org[1].trim());
    if (proj?.[1]) project = proj[1].trim();
  }
  if (!organization || !project) return null;
  return { organization, project };
}

export function parseAzTokenJson(text: string, now: number): { token: string; expiresAt: number } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const token = "accessToken" in value && typeof value.accessToken === "string" ? value.accessToken.trim() : "";
  if (token.length < 20 || /\s/.test(token)) return null;
  const expiresOn =
    "expires_on" in value && typeof value.expires_on === "number" && Number.isFinite(value.expires_on)
      ? value.expires_on * 1000
      : now + 10 * 60 * 1000;
  return { token, expiresAt: expiresOn };
}

export async function getAzBearerToken(
  signal: AbortSignal,
  run: AzRunner = runAz,
): Promise<{ ok: true; token: string; expiresAt: number } | { ok: false; message: string }> {
  try {
    const result = await run(
      ["account", "get-access-token", "--resource", DEVOPS_RESOURCE, "-o", "json"],
      signal,
    );
    const parsed = parseAzTokenJson(result.stdout, Date.now());
    if (!parsed) return { ok: false, message: azFailure(result.stderr) };
    return { ok: true, token: parsed.token, expiresAt: parsed.expiresAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "Azure CLI is not installed.") return { ok: false, message };
    return { ok: false, message: "Azure CLI is not signed in. Run az login." };
  }
}

export async function readAzDefaults(
  signal: AbortSignal,
  run: AzRunner = runAz,
): Promise<AzDefaults | null> {
  try {
    const result = await run(["devops", "configure", "--list"], signal);
    return parseAzDevopsDefaults(result.stdout);
  } catch {
    return null;
  }
}

export const runAz: AzRunner = async (args, signal) => {
  const bin = await azBin();
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      [...args],
      { signal, timeout: 15_000, maxBuffer: 1_000_000 },
      (error, stdout, stderr) => {
        if (error && "code" in error && error.code === "ENOENT") {
          reject(new Error("Azure CLI is not installed."));
          return;
        }
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? (error instanceof Error ? error.message : ""),
        });
      },
    );
  });
};

function organizationName(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host === "dev.azure.com") {
      const name = url.pathname.split("/").filter(Boolean)[0] ?? "";
      return decodeURIComponent(name);
    }
    if (host.endsWith(".visualstudio.com")) return host.slice(0, -".visualstudio.com".length);
  } catch {
    return value.replace(/\/$/, "");
  }
  return value.replace(/\/$/, "");
}

function azFailure(stderr: string): string {
  const text = redact(stderr).trim();
  if (/not logged in|az login|AADSTS|please run/i.test(text)) {
    return "Azure CLI is not signed in. Run az login.";
  }
  return "Azure CLI is not signed in. Run az login.";
}

function redact(text: string): string {
  return text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[token]");
}

async function azBin(): Promise<string> {
  for (const candidate of ["/opt/homebrew/bin/az", "/usr/local/bin/az"]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next install path.
    }
  }
  return "az";
}
