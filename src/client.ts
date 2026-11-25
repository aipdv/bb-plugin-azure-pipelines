import { z } from "zod";
import {
  buildOutcomeOf,
  clip,
  folderLabel,
  isActiveOutcome,
  isAzureWebUrl,
  runStatusOf,
  safeBuildUrl,
  shortBranch,
  summarizeTimeline,
  type DefinitionSummary,
  type LatestRunSummary,
  type PipelineView,
  type RunSummary,
  type TimelineRecordInput,
} from "./ado";

const MAX_PIPELINES = 5;
const MAX_ACTIVE_TIMELINES = 3;

const buildSchema = z.object({
  id: z.number().int(),
  buildNumber: z.string().optional(),
  status: z.string().optional(),
  result: z.string().nullable().optional(),
  sourceBranch: z.string().nullable().optional(),
  queueTime: z.string().nullable().optional(),
  startTime: z.string().nullable().optional(),
  finishTime: z.string().nullable().optional(),
  requestedFor: z.object({ displayName: z.string().optional() }).optional(),
  definition: z
    .object({
      id: z.number().int().optional(),
      name: z.string().optional(),
      path: z.string().optional(),
    })
    .optional(),
  repository: z.object({ name: z.string().optional() }).optional(),
  _links: z
    .object({
      web: z.object({ href: z.string().optional() }).optional(),
    })
    .optional(),
});

const definitionApiSchema = z.object({
  id: z.number().int(),
  name: z.string().optional(),
  path: z.string().optional(),
  latestBuild: buildSchema.nullable().optional(),
  _links: z
    .object({
      web: z.object({ href: z.string().optional() }).optional(),
    })
    .optional(),
});

const timelineSchema = z.object({
  records: z
    .array(
      z.object({
        type: z.string().optional(),
        name: z.string().nullable().optional(),
        state: z.string().nullable().optional(),
        result: z.string().nullable().optional(),
        order: z.number().nullable().optional(),
        percentComplete: z.number().nullable().optional(),
        identifier: z.string().nullable().optional(),
        attempt: z.number().nullable().optional(),
      }),
    )
    .optional(),
});

const repoSchema = z.object({
  id: z.string().min(1),
});

export type PipelineAuth =
  | { type: "pat"; secret: string }
  | { type: "bearer"; token: string };

export interface PipelineQuery {
  organization: string;
  project: string;
  auth: PipelineAuth;
  repoName: string | null;
  pipelineFilter: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface FetchResult {
  pipelines: PipelineView[];
  hiddenCount: number;
  notice: string | null;
}

export type FetchOutcome =
  | { ok: true; result: FetchResult }
  | { ok: false; message: string };

export type DefinitionsOutcome =
  | { ok: true; definitions: DefinitionSummary[]; activeTotal: number }
  | { ok: false; message: string };

export type RunsOutcome =
  | {
      ok: true;
      definitionId: number;
      definitionName: string;
      folder: string;
      definitionUrl: string | null;
      runs: RunSummary[];
    }
  | { ok: false; message: string };

export type RunDetailOutcome =
  | { ok: true; run: RunSummary }
  | { ok: false; message: string };

export async function fetchPipelineStatus(query: PipelineQuery): Promise<FetchOutcome> {
  const fetchImpl = query.fetchImpl ?? fetch;
  const base = apiBase(query.organization, query.project);
  if (!isAzureWebUrl(`${base}/`)) {
    return { ok: false, message: "Organization or project is not a valid Azure DevOps name." };
  }

  try {
    let repositoryId: string | null = null;
    if (query.repoName) {
      const repo = await requestJson(
        `${base}/_apis/git/repositories/${encodeURIComponent(query.repoName)}?api-version=7.1`,
        query.auth,
        query.signal,
        fetchImpl,
      );
      if (!repo.ok) {
        if (repo.status === 404) {
          return {
            ok: true,
            result: {
              pipelines: [],
              hiddenCount: 0,
              notice: `Azure DevOps has no repo named ${query.repoName} in ${query.project}.`,
            },
          };
        }
        return { ok: false, message: repo.message };
      }
      const parsed = repoSchema.safeParse(repo.value);
      if (!parsed.success) {
        return { ok: false, message: "Azure DevOps returned an unreadable repo." };
      }
      repositoryId = parsed.data.id;
    }

    const extra: Record<string, string> = {};
    if (repositoryId) {
      extra.repositoryId = repositoryId;
      extra.repositoryType = "TfsGit";
    }
    const [running, queued] = await Promise.all([
      listBuilds(base, query, fetchImpl, "inProgress", "25", extra),
      listBuilds(base, query, fetchImpl, "notStarted", "10", extra),
    ]);
    if (!running.ok) return { ok: false, message: running.message };
    if (!queued.ok) return { ok: false, message: queued.message };

    const filter = query.pipelineFilter.trim().toLowerCase();
    const merged = dedupeBuilds([...running.builds, ...queued.builds]);
    const matched = filter
      ? merged.filter((build) => (build.definition?.name ?? "").toLowerCase().includes(filter))
      : merged;
    const notice =
      filter && matched.length === 0 && merged.length > 0
        ? `No running pipeline matches "${query.pipelineFilter.trim()}".`
        : null;
    const ranked = matched.slice().sort(compareBuilds);
    const visible = ranked.slice(0, MAX_PIPELINES);
    const pipelines = await Promise.all(
      visible.map((build) => toPipeline(base, query, fetchImpl, build)),
    );
    return {
      ok: true,
      result: {
        pipelines,
        hiddenCount: Math.max(0, ranked.length - visible.length),
        notice,
      },
    };
  } catch (error) {
    if (query.signal.aborted) {
      return { ok: false, message: "Pipeline status was cancelled." };
    }
    return { ok: false, message: publicError(error) };
  }
}

export async function fetchDefinitions(input: {
  organization: string;
  project: string;
  auth: PipelineAuth;
  pipelineFilter: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<DefinitionsOutcome> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = apiBase(input.organization, input.project);
  if (!isAzureWebUrl(`${base}/`)) {
    return { ok: false, message: "Organization or project is not a valid Azure DevOps name." };
  }
  const queryLike = { auth: input.auth, signal: input.signal };
  try {
    const [defsRes, running, queued] = await Promise.all([
      requestJson(
        `${base}/_apis/build/definitions?includeLatestBuilds=true&api-version=7.1`,
        input.auth,
        input.signal,
        fetchImpl,
      ),
      listBuilds(base, queryLike, fetchImpl, "inProgress", "50", {}),
      listBuilds(base, queryLike, fetchImpl, "notStarted", "25", {}),
    ]);
    if (!defsRes.ok) return { ok: false, message: defsRes.message };
    const listParsed = z.object({ value: z.array(z.unknown()).optional() }).safeParse(defsRes.value);
    if (!listParsed.success) {
      return { ok: false, message: "Azure DevOps returned an unreadable pipeline list." };
    }

    const activeByDef = new Map<number, z.infer<typeof buildSchema>[]>();
    const activeBuilds = dedupeBuilds([
      ...(running.ok ? running.builds : []),
      ...(queued.ok ? queued.builds : []),
    ]);
    for (const build of activeBuilds) {
      const defId = build.definition?.id;
      if (typeof defId !== "number") continue;
      const bucket = activeByDef.get(defId);
      if (bucket) bucket.push(build);
      else activeByDef.set(defId, [build]);
    }

    const filter = input.pipelineFilter.trim().toLowerCase();
    const definitions: DefinitionSummary[] = [];
    for (const entry of listParsed.data.value ?? []) {
      const parsed = definitionApiSchema.safeParse(entry);
      if (!parsed.success) continue;
      const def = parsed.data;
      const name = clip(def.name || `Pipeline ${def.id}`, 100);
      if (filter && !name.toLowerCase().includes(filter)) continue;
      const activeList = (activeByDef.get(def.id) ?? []).slice().sort(compareBuilds);
      const preferredBuild = activeList[0] ?? def.latestBuild ?? null;
      definitions.push({
        id: def.id,
        name,
        folder: folderLabel(def.path),
        url: safeBuildUrl(
          def._links?.web?.href,
          `${base}/_build/definition?definitionId=${def.id}`,
        ),
        activeCount: activeList.length,
        latestRun: preferredBuild ? toLatestRun(base, preferredBuild) : null,
      });
    }

    definitions.sort(
      (left, right) =>
        left.folder.localeCompare(right.folder, undefined, { sensitivity: "base" }) ||
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );
    const activeTotal = definitions.reduce((sum, item) => sum + item.activeCount, 0);
    return { ok: true, definitions, activeTotal };
  } catch (error) {
    if (input.signal.aborted) {
      return { ok: false, message: "Pipeline list was cancelled." };
    }
    return { ok: false, message: publicError(error) };
  }
}

export async function fetchDefinitionRuns(input: {
  organization: string;
  project: string;
  definitionId: number;
  auth: PipelineAuth;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<RunsOutcome> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = apiBase(input.organization, input.project);
  if (!isAzureWebUrl(`${base}/`)) {
    return { ok: false, message: "Organization or project is not a valid Azure DevOps name." };
  }
  const params = new URLSearchParams({
    "api-version": "7.1",
    definitions: String(input.definitionId),
    queryOrder: "queueTimeDescending",
    $top: "15",
  });
  try {
    const [defRes, buildsRes] = await Promise.all([
      requestJson(
        `${base}/_apis/build/definitions/${input.definitionId}?api-version=7.1`,
        input.auth,
        input.signal,
        fetchImpl,
      ),
      requestJson(
        `${base}/_apis/build/builds?${params}`,
        input.auth,
        input.signal,
        fetchImpl,
      ),
    ]);
    if (!buildsRes.ok) return { ok: false, message: buildsRes.message };
    const listParsed = z.object({ value: z.array(z.unknown()).optional() }).safeParse(buildsRes.value);
    if (!listParsed.success) {
      return { ok: false, message: "Azure DevOps returned an unreadable run list." };
    }

    const defParsed = defRes.ok ? definitionApiSchema.safeParse(defRes.value) : null;
    const rawBuilds: z.infer<typeof buildSchema>[] = [];
    for (const entry of listParsed.data.value ?? []) {
      const parsed = buildSchema.safeParse(entry);
      if (parsed.success) rawBuilds.push(parsed.data);
    }

    const firstDef = rawBuilds[0]?.definition;
    const definitionName = clip(
      (defParsed?.success ? defParsed.data.name : undefined) ||
        firstDef?.name ||
        `Pipeline ${input.definitionId}`,
      100,
    );
    const folder = folderLabel(
      (defParsed?.success ? defParsed.data.path : undefined) ?? firstDef?.path,
    );
    const definitionUrl = safeBuildUrl(
      defParsed?.success ? defParsed.data._links?.web?.href : undefined,
      `${base}/_build/definition?definitionId=${input.definitionId}`,
    );

    const ranked = rawBuilds.slice().sort((left, right) => {
      const leftActive = isActiveOutcome(buildOutcomeOf(left.status, left.result)) ? 0 : 1;
      const rightActive = isActiveOutcome(buildOutcomeOf(right.status, right.result)) ? 0 : 1;
      return leftActive - rightActive || right.id - left.id;
    });

    const activeIds = new Set(
      ranked
        .filter((build) => isActiveOutcome(buildOutcomeOf(build.status, build.result)))
        .slice(0, MAX_ACTIVE_TIMELINES)
        .map((build) => build.id),
    );

    const runs = await Promise.all(
      ranked.map(async (build) => {
        const summary = toRunSummary(base, build, input.definitionId, definitionName);
        if (!activeIds.has(build.id)) return summary;
        return attachTimeline(base, input.auth, input.signal, fetchImpl, summary);
      }),
    );

    return {
      ok: true,
      definitionId: input.definitionId,
      definitionName,
      folder,
      definitionUrl,
      runs,
    };
  } catch (error) {
    if (input.signal.aborted) {
      return { ok: false, message: "Pipeline runs were cancelled." };
    }
    return { ok: false, message: publicError(error) };
  }
}

export async function fetchBuildDetail(input: {
  organization: string;
  project: string;
  buildId: number;
  auth: PipelineAuth;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<RunDetailOutcome> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = apiBase(input.organization, input.project);
  if (!isAzureWebUrl(`${base}/`)) {
    return { ok: false, message: "Organization or project is not a valid Azure DevOps name." };
  }
  try {
    const [buildRes, timelineRes] = await Promise.all([
      requestJson(
        `${base}/_apis/build/builds/${input.buildId}?api-version=7.1`,
        input.auth,
        input.signal,
        fetchImpl,
      ),
      requestJson(
        `${base}/_apis/build/builds/${input.buildId}/timeline?api-version=7.1`,
        input.auth,
        input.signal,
        fetchImpl,
      ),
    ]);
    if (!buildRes.ok) return { ok: false, message: buildRes.message };
    const parsed = buildSchema.safeParse(buildRes.value);
    if (!parsed.success) {
      return { ok: false, message: "Azure DevOps returned an unreadable build." };
    }
    const build = parsed.data;
    const summary = toRunSummary(
      base,
      build,
      build.definition?.id ?? 0,
      clip(build.definition?.name || "Pipeline", 100),
    );
    return { ok: true, run: applyTimelineResult(summary, timelineRes) };
  } catch (error) {
    if (input.signal.aborted) {
      return { ok: false, message: "Build detail was cancelled." };
    }
    return { ok: false, message: publicError(error) };
  }
}

function apiBase(organization: string, project: string): string {
  return `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}`;
}

async function listBuilds(
  base: string,
  query: { auth: PipelineAuth; signal: AbortSignal },
  fetchImpl: typeof fetch,
  statusFilter: string,
  top: string,
  extra: Record<string, string>,
): Promise<{ ok: true; builds: z.infer<typeof buildSchema>[] } | { ok: false; message: string }> {
  const params = new URLSearchParams({
    "api-version": "7.1",
    statusFilter,
    queryOrder: "queueTimeDescending",
    $top: top,
    ...extra,
  });
  const response = await requestJson(
    `${base}/_apis/build/builds?${params}`,
    query.auth,
    query.signal,
    fetchImpl,
  );
  if (!response.ok) return response;
  const value = z.object({ value: z.array(z.unknown()).optional() }).safeParse(response.value);
  if (!value.success) return { ok: false, message: "Azure DevOps returned an unreadable build list." };
  const builds: z.infer<typeof buildSchema>[] = [];
  for (const entry of value.data.value ?? []) {
    const parsed = buildSchema.safeParse(entry);
    if (parsed.success) builds.push(parsed.data);
  }
  return { ok: true, builds };
}

function toLatestRun(base: string, build: z.infer<typeof buildSchema>): LatestRunSummary {
  const fallback = `${base}/_build/results?buildId=${build.id}`;
  return {
    id: build.id,
    buildNumber: clip(build.buildNumber || String(build.id), 40),
    outcome: buildOutcomeOf(build.status, build.result),
    branch: shortBranch(build.sourceBranch),
    queueTime: build.queueTime ?? null,
    finishTime: build.finishTime ?? null,
    url: safeBuildUrl(build._links?.web?.href, fallback),
  };
}

function toRunSummary(
  base: string,
  build: z.infer<typeof buildSchema>,
  definitionId: number,
  definitionName: string,
): RunSummary {
  const fallback = `${base}/_build/results?buildId=${build.id}`;
  return {
    id: build.id,
    definitionId,
    definitionName,
    buildNumber: clip(build.buildNumber || String(build.id), 40),
    outcome: buildOutcomeOf(build.status, build.result),
    branch: shortBranch(build.sourceBranch),
    requestedBy: build.requestedFor?.displayName ? clip(build.requestedFor.displayName, 60) : null,
    queueTime: build.queueTime ?? null,
    startTime: build.startTime ?? null,
    finishTime: build.finishTime ?? null,
    url: safeBuildUrl(build._links?.web?.href, fallback),
    percent: null,
    stages: null,
    stagesNote: null,
  };
}

async function attachTimeline(
  base: string,
  auth: PipelineAuth,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
  summary: RunSummary,
): Promise<RunSummary> {
  const timeline = await requestJson(
    `${base}/_apis/build/builds/${summary.id}/timeline?api-version=7.1`,
    auth,
    signal,
    fetchImpl,
  );
  return applyTimelineResult(summary, timeline);
}

function applyTimelineResult(summary: RunSummary, timeline: JsonResult): RunSummary {
  if (!timeline.ok) {
    return { ...summary, percent: 0, stages: [], stagesNote: "Stages are not available yet." };
  }
  const parsed = timelineSchema.safeParse(timeline.value);
  if (!parsed.success) {
    return { ...summary, percent: 0, stages: [], stagesNote: "Stages are not available yet." };
  }
  const result = summarizeTimeline((parsed.data.records ?? []) as TimelineRecordInput[]);
  return {
    ...summary,
    percent: result.percent,
    stages: result.stages,
    stagesNote: result.stages.length === 0 ? "No stages reported." : null,
  };
}

async function toPipeline(
  base: string,
  query: PipelineQuery,
  fetchImpl: typeof fetch,
  build: z.infer<typeof buildSchema>,
): Promise<PipelineView> {
  const fallback = `${base}/_build/results?buildId=${build.id}`;
  const view: PipelineView = {
    id: build.id,
    name: clip(build.definition?.name || "Pipeline", 80),
    buildNumber: clip(build.buildNumber || String(build.id), 40),
    runStatus: runStatusOf(build.status),
    percent: 0,
    branch: shortBranch(build.sourceBranch),
    url: safeBuildUrl(build._links?.web?.href, fallback),
    stages: [],
    stagesNote: null,
  };
  const timeline = await requestJson(
    `${base}/_apis/build/builds/${build.id}/timeline?api-version=7.1`,
    query.auth,
    query.signal,
    fetchImpl,
  );
  if (!timeline.ok) {
    view.stagesNote = "Stages are not available yet.";
    return view;
  }
  const parsed = timelineSchema.safeParse(timeline.value);
  if (!parsed.success) {
    view.stagesNote = "Stages are not available yet.";
    return view;
  }
  const summary = summarizeTimeline((parsed.data.records ?? []) as TimelineRecordInput[]);
  view.percent = summary.percent;
  view.stages = summary.stages;
  if (summary.stages.length === 0) view.stagesNote = "No stages reported.";
  return view;
}

function dedupeBuilds(builds: readonly z.infer<typeof buildSchema>[]): z.infer<typeof buildSchema>[] {
  const seen = new Set<number>();
  const result: z.infer<typeof buildSchema>[] = [];
  for (const build of builds) {
    if (seen.has(build.id)) continue;
    seen.add(build.id);
    result.push(build);
  }
  return result;
}

function compareBuilds(
  left: z.infer<typeof buildSchema>,
  right: z.infer<typeof buildSchema>,
): number {
  const rank = (status: string | undefined) =>
    status === "inProgress" || status === "cancelling" ? 0 : 1;
  return rank(left.status) - rank(right.status) || right.id - left.id;
}

type JsonResult =
  | { ok: true; value: unknown }
  | { ok: false; status: number; message: string };

export async function fetchProjectName(input: {
  organization: string;
  project: string;
  auth: PipelineAuth;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.project)) {
    return input.project;
  }
  const url = `https://dev.azure.com/${encodeURIComponent(input.organization)}/_apis/projects/${encodeURIComponent(input.project)}?api-version=7.1`;
  const response = await requestJson(url, input.auth, input.signal, input.fetchImpl ?? fetch);
  if (!response.ok) return input.project;
  const parsed = z.object({ name: z.string().min(1) }).safeParse(response.value);
  return parsed.success ? parsed.data.name : input.project;
}

async function requestJson(
  url: string,
  auth: PipelineAuth,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<JsonResult> {
  if (!isAzureWebUrl(url)) {
    return { ok: false, status: 0, message: "Refused a non-Azure DevOps URL." };
  }
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      Authorization: authorizationHeader(auth),
    },
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, status: response.status, message: httpMessage(response.status, text, auth.type) };
  }
  if (!text) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: response.status, message: "Azure DevOps returned an unreadable response." };
  }
}

function authorizationHeader(auth: PipelineAuth): string {
  if (auth.type === "bearer") return `Bearer ${auth.token}`;
  return `Basic ${Buffer.from(`:${auth.secret}`).toString("base64")}`;
}

function httpMessage(status: number, body: string, authType: PipelineAuth["type"]): string {
  if (status === 401 || status === 403) {
    if (authType === "bearer") return "Azure CLI sign-in cannot read pipelines. Run az login.";
    return "Azure DevOps refused the token. The token needs Build (Read).";
  }
  if (status === 404) return "Azure DevOps project was not found.";
  const parsed = parseMessage(body);
  if (parsed) return clip(parsed, 180);
  return `Azure DevOps returned HTTP ${status}.`;
}

function parseMessage(body: string): string | null {
  try {
    const value: unknown = JSON.parse(body);
    if (value && typeof value === "object" && "message" in value && typeof value.message === "string") {
      return value.message;
    }
  } catch {
    return null;
  }
  return null;
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (!message || /authorization|bearer|basic|token/i.test(message)) {
    return "Could not reach Azure DevOps.";
  }
  return clip(message, 180);
}
