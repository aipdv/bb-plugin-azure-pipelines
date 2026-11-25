import { defineCli, cliCommand, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  formatStatus,
  isSafeOrganization,
  isSafePipelineFilter,
  isSafeProject,
  parseAzureRemote,
  scopeLabel,
  type AzureRepo,
} from "./src/ado";
import { readGitConfigText } from "./src/git-config";
import { getAzBearerToken, readAzDefaults, type AzDefaults } from "./src/az-cli";
import {
  fetchBuildDetail,
  fetchDefinitionRuns,
  fetchDefinitions,
  fetchPipelineStatus,
  fetchProjectName,
  type PipelineAuth,
} from "./src/client";
import {
  definitionsResultSchema,
  rpcContract,
  runDetailResultSchema,
  runsResultSchema,
  statusResultSchema,
} from "./src/contract";

const SETUP_MESSAGE =
  "Sign in with Azure CLI (az login). Organization and project come from az devops configure. A personal access token is optional.";

const optionalName = (check: (value: string) => boolean, message: string) =>
  z.string().max(128).refine((value) => value.trim() === "" || check(value.trim()), message);

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    token: {
      type: "string",
      label: "Personal access token (Build read)",
      secret: true,
      experimental_schema: z.string().min(8, "Token is too short.").max(256),
    },
    organization: {
      type: "string",
      label: "Organization",
      default: "",
      experimental_schema: optionalName(
        isSafeOrganization,
        "Use the Azure DevOps organization name, not a URL.",
      ),
    },
    project: {
      type: "string",
      label: "Project",
      default: "",
      experimental_schema: optionalName(
        isSafeProject,
        "Use the Azure DevOps project name, not a URL.",
      ),
    },
    pipeline: {
      type: "string",
      label: "Pipeline name filter",
      default: "",
      experimental_schema: z
        .string()
        .max(128)
        .refine(isSafePipelineFilter, "Pipeline filter cannot contain control characters."),
    },
  });

  let cachedToken: { token: string; expiresAt: number } | null = null;

  const initial = await settings.get();
  const signedIn = initial.token ? true : await azureCliSignedIn(AbortSignal.timeout(15_000));
  if (!initial.token && !signedIn) bb.status.needsConfiguration(SETUP_MESSAGE);
  settings.onChange((next) => {
    if (next.token) return;
    void azureCliSignedIn(AbortSignal.timeout(15_000)).then((ok) => {
      if (!ok) bb.status.needsConfiguration(SETUP_MESSAGE);
    });
  });

  async function azureCliSignedIn(signal: AbortSignal): Promise<boolean> {
    const auth = await bearerAuth(signal);
    return auth !== null;
  }

  async function bearerAuth(signal: AbortSignal): Promise<PipelineAuth | null> {
    const now = Date.now();
    if (cachedToken && cachedToken.expiresAt - 60_000 > now) {
      return { type: "bearer", token: cachedToken.token };
    }
    const result = await getAzBearerToken(signal);
    if (!result.ok) return null;
    cachedToken = { token: result.token, expiresAt: result.expiresAt };
    return { type: "bearer", token: result.token };
  }

  async function resolveTarget(environmentId: string | null, signal: AbortSignal) {
    const current = await settings.get();
    const auth =
      (await bearerAuth(signal)) ??
      (current.token ? { type: "pat" as const, secret: current.token } : null);
    if (!auth) {
      return { ok: false as const, error: { status: "needs-setup" as const, message: SETUP_MESSAGE } };
    }

    const detected = environmentId ? await detectRepo(bb, environmentId, signal) : null;
    const defaults = await defaultsFor(signal);
    const organization = current.organization.trim() || detected?.organization || defaults?.organization || "";
    let project = current.project.trim() || detected?.project || defaults?.project || "";
    if (!organization || !project) {
      return { ok: false as const, error: { status: "needs-setup" as const, message: SETUP_MESSAGE } };
    }
    project = await fetchProjectName({ organization, project, auth, signal });
    if (
      !isSafeOrganization(organization) ||
      !isSafeProject(project) ||
      !isSafePipelineFilter(current.pipeline)
    ) {
      return {
        ok: false as const,
        error: {
          status: "failed" as const,
          message: "Organization or project is not a valid Azure DevOps name.",
          organization,
          project,
        },
      };
    }

    const sameTarget =
      detected !== null &&
      detected.organization.toLowerCase() === organization.toLowerCase() &&
      detected.project.toLowerCase() === project.toLowerCase();
    return {
      ok: true as const,
      organization,
      project,
      auth,
      repoName: sameTarget ? detected.repo : null,
      pipelineFilter: current.pipeline.trim(),
    };
  }

  async function loadStatus(environmentId: string | null, signal: AbortSignal) {
    const target = await resolveTarget(environmentId, signal);
    if (!target.ok) return target.error;
    const outcome = await fetchPipelineStatus({
      organization: target.organization,
      project: target.project,
      auth: target.auth,
      repoName: target.repoName,
      pipelineFilter: target.pipelineFilter,
      signal: withTimeout(signal),
    });
    if (!outcome.ok) {
      bb.log.warn(`pipeline status failed: ${outcome.message}`);
      return {
        status: "failed" as const,
        message: outcome.message,
        organization: target.organization,
        project: target.project,
      };
    }
    return {
      status: "ready" as const,
      organization: target.organization,
      project: target.project,
      repoName: target.repoName,
      pipelineFilter: target.pipelineFilter,
      scopeLabel: scopeLabel({
        project: target.project,
        repoName: target.repoName,
        pipelineFilter: target.pipelineFilter,
      }),
      notice: outcome.result.notice,
      pipelines: outcome.result.pipelines,
      hiddenCount: outcome.result.hiddenCount,
      checkedAt: new Date().toISOString(),
    };
  }

  async function readDefaultIds(organization: string, project: string): Promise<number[]> {
    const raw = await bb.storage.kv.get<unknown>(defaultsKey(organization, project));
    if (!Array.isArray(raw)) return [];
    const seen = new Set<number>();
    const ids: number[] = [];
    for (const item of raw) {
      if (typeof item === "number" && Number.isInteger(item) && item > 0 && !seen.has(item)) {
        seen.add(item);
        ids.push(item);
      }
    }
    return ids;
  }

  async function saveDefaultIds(
    environmentId: string | null,
    definitionIds: readonly number[],
    signal: AbortSignal,
  ): Promise<{ defaultIds: number[] }> {
    const target = await resolveTarget(environmentId, signal);
    const cleaned = [...new Set(definitionIds.filter((id) => Number.isInteger(id) && id > 0))].sort(
      (a, b) => a - b,
    );
    if (!target.ok) return { defaultIds: cleaned };
    await bb.storage.kv.set(defaultsKey(target.organization, target.project), cleaned);
    return { defaultIds: cleaned };
  }

  async function loadDefinitions(environmentId: string | null, signal: AbortSignal) {
    const target = await resolveTarget(environmentId, signal);
    if (!target.ok) return target.error;
    const [outcome, defaultIds] = await Promise.all([
      fetchDefinitions({
        organization: target.organization,
        project: target.project,
        auth: target.auth,
        pipelineFilter: target.pipelineFilter,
        signal: withTimeout(signal),
      }),
      readDefaultIds(target.organization, target.project),
    ]);
    if (!outcome.ok) {
      bb.log.warn(`pipeline list failed: ${outcome.message}`);
      return {
        status: "failed" as const,
        message: outcome.message,
        organization: target.organization,
        project: target.project,
      };
    }
    return {
      status: "ready" as const,
      organization: target.organization,
      project: target.project,
      scopeLabel: scopeLabel({
        project: target.project,
        repoName: null,
        pipelineFilter: target.pipelineFilter,
      }),
      definitions: outcome.definitions,
      defaultIds,
      activeTotal: outcome.activeTotal,
      checkedAt: new Date().toISOString(),
    };
  }

  async function loadRuns(
    environmentId: string | null,
    definitionId: number,
    signal: AbortSignal,
  ) {
    const target = await resolveTarget(environmentId, signal);
    if (!target.ok) return target.error;
    const outcome = await fetchDefinitionRuns({
      organization: target.organization,
      project: target.project,
      definitionId,
      auth: target.auth,
      signal: withTimeout(signal),
    });
    if (!outcome.ok) {
      bb.log.warn(`pipeline runs failed: ${outcome.message}`);
      return {
        status: "failed" as const,
        message: outcome.message,
        organization: target.organization,
        project: target.project,
      };
    }
    return {
      status: "ready" as const,
      organization: target.organization,
      project: target.project,
      definitionId: outcome.definitionId,
      definitionName: outcome.definitionName,
      folder: outcome.folder,
      definitionUrl: outcome.definitionUrl,
      runs: outcome.runs,
      checkedAt: new Date().toISOString(),
    };
  }

  async function loadRun(environmentId: string | null, buildId: number, signal: AbortSignal) {
    const target = await resolveTarget(environmentId, signal);
    if (!target.ok) return target.error;
    const outcome = await fetchBuildDetail({
      organization: target.organization,
      project: target.project,
      buildId,
      auth: target.auth,
      signal: withTimeout(signal),
    });
    if (!outcome.ok) {
      bb.log.warn(`build detail failed: ${outcome.message}`);
      return {
        status: "failed" as const,
        message: outcome.message,
        organization: target.organization,
        project: target.project,
      };
    }
    return {
      status: "ready" as const,
      organization: target.organization,
      project: target.project,
      run: outcome.run,
      checkedAt: new Date().toISOString(),
    };
  }

  bb.rpc.register(
    rpcContract,
    {
      async status({ environmentId }, ctx) {
        return statusResultSchema.parse(await loadStatus(environmentId, ctx.experimental_signal));
      },
      async definitions({ environmentId }, ctx) {
        return definitionsResultSchema.parse(
          await loadDefinitions(environmentId, ctx.experimental_signal),
        );
      },
      async runs({ environmentId, definitionId }, ctx) {
        return runsResultSchema.parse(
          await loadRuns(environmentId, definitionId, ctx.experimental_signal),
        );
      },
      async run({ environmentId, buildId }, ctx) {
        return runDetailResultSchema.parse(
          await loadRun(environmentId, buildId, ctx.experimental_signal),
        );
      },
      async setDefaults({ environmentId, definitionIds }, ctx) {
        return saveDefaultIds(environmentId, definitionIds, ctx.experimental_signal);
      },
    },
    {
      experimental_discoverable: true,
      experimental_description: "Browse Azure DevOps pipelines, runs, and live stage progress.",
    },
  );

  bb.cli.register(
    defineCli({
      name: "azure-pipelines",
      summary: "Show running Azure DevOps pipelines",
      commands: {
        status: cliCommand({
          summary: "Print running pipelines, percent complete, and stage status",
          options: {
            environment: {
              type: "string",
              description: "BB environment id. Limits the list to that checkout's Azure DevOps repo.",
            },
            json: {
              type: "boolean",
              description: "Print the status payload as JSON",
            },
          },
          async run(input, ctx) {
            const payload = statusResultSchema.parse(
              await loadStatus(input.options.environment ?? null, ctx.signal ?? AbortSignal.timeout(12_000)),
            );
            if (input.options.json) {
              return {
                exitCode: payload.status === "ready" ? 0 : 1,
                stdout: `${JSON.stringify(payload)}\n`,
              };
            }
            return {
              exitCode: payload.status === "ready" ? 0 : 1,
              stdout: formatStatus(payload),
            };
          },
        }),
      },
    }),
  );
}

async function defaultsFor(signal: AbortSignal): Promise<AzDefaults | null> {
  return readAzDefaults(signal);
}

function defaultsKey(organization: string, project: string): string {
  return `defaultPipelines:${organization.toLowerCase()}/${project.toLowerCase()}`;
}

function withTimeout(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
}

async function detectRepo(
  bb: BbPluginApi,
  environmentId: string,
  signal: AbortSignal,
): Promise<AzureRepo | null> {
  try {
    const environment = await bb.sdk.environments.get({ environmentId, signal });
    if (!environment.path) return null;
    const config = await readGitConfigText(
      (filePath) => readHostText(bb, environment.hostId, filePath, signal),
      environment.path,
    );
    if (!config) return null;
    return parseAzureRemote(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    bb.log.debug(`git remote lookup failed: ${message}`);
    return null;
  }
}

async function readHostText(
  bb: BbPluginApi,
  hostId: string,
  filePath: string,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const file = await bb.sdk.files.read({ hostId, path: filePath, signal });
    if (file.sizeBytes > 256 * 1024) return null;
    if (file.contentEncoding === "base64") {
      return Buffer.from(file.content, "base64").toString("utf8");
    }
    return file.content;
  } catch {
    return null;
  }
}
