export type StageStatus =
  | "waiting"
  | "running"
  | "done"
  | "failed"
  | "canceled"
  | "partial";

export type RunStatus = "running" | "queued" | "canceling";

export type BuildOutcome =
  | "running"
  | "queued"
  | "canceling"
  | "succeeded"
  | "failed"
  | "partial"
  | "canceled"
  | "idle";

export interface StageView {
  name: string;
  status: StageStatus;
}

export interface PipelineView {
  id: number;
  name: string;
  buildNumber: string;
  runStatus: RunStatus;
  percent: number;
  branch: string | null;
  url: string | null;
  stages: StageView[];
  stagesNote: string | null;
}

export interface LatestRunSummary {
  id: number;
  buildNumber: string;
  outcome: BuildOutcome;
  branch: string | null;
  queueTime: string | null;
  finishTime: string | null;
  url: string | null;
}

export interface DefinitionSummary {
  id: number;
  name: string;
  folder: string;
  url: string | null;
  activeCount: number;
  latestRun: LatestRunSummary | null;
}

export interface RunSummary {
  id: number;
  definitionId: number;
  definitionName: string;
  buildNumber: string;
  outcome: BuildOutcome;
  branch: string | null;
  requestedBy: string | null;
  queueTime: string | null;
  startTime: string | null;
  finishTime: string | null;
  url: string | null;
  percent: number | null;
  stages: StageView[] | null;
  stagesNote: string | null;
}

export interface AzureRepo {
  organization: string;
  project: string;
  repo: string;
}

export interface TimelineRecordInput {
  type?: string;
  name?: string | null;
  state?: string | null;
  result?: string | null;
  order?: number | null;
  percentComplete?: number | null;
  identifier?: string | null;
  attempt?: number | null;
}

const STAGE_TYPES = ["Stage", "Phase", "Job"] as const;

export function isSafeOrganization(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(value);
}

export function isSafeProject(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(value) && !value.includes("..")
  );
}

export function isSafePipelineFilter(value: string): boolean {
  return value.length <= 128 && !/[\u0000-\u001f]/.test(value);
}

export function scopeLabel(input: {
  project: string;
  repoName: string | null;
  pipelineFilter: string;
}): string {
  const parts = [input.repoName ?? input.project];
  const filter = input.pipelineFilter.trim();
  if (filter) parts.push(filter);
  return parts.join(" · ");
}

export function folderLabel(path: string | null | undefined): string {
  const cleaned = (path ?? "").replace(/^[\\/]+|[\\/]+$/g, "").replace(/\\/g, " / ").trim();
  return cleaned || "Root";
}

export function shortBranch(sourceBranch: string | null | undefined): string | null {
  if (!sourceBranch) return null;
  const trimmed = sourceBranch.trim();
  const heads = /^refs\/heads\/(.+)$/.exec(trimmed);
  if (heads?.[1]) return clip(heads[1].trim(), 80);
  const pull = /^refs\/pull\/(\d+)\//.exec(trimmed);
  if (pull?.[1]) return `PR ${pull[1]}`;
  return clip(trimmed.replace(/^refs\//, ""), 80);
}

export function runStatusOf(status: string | undefined): RunStatus {
  if (status === "notStarted" || status === "postponed" || status === "none") {
    return "queued";
  }
  if (status === "cancelling") return "canceling";
  return "running";
}

export function buildOutcomeOf(
  status: string | null | undefined,
  result: string | null | undefined,
): BuildOutcome {
  if (!status) return "idle";
  if (status === "inProgress") return "running";
  if (status === "cancelling") return "canceling";
  if (status === "notStarted" || status === "postponed" || status === "none") {
    return "queued";
  }
  if (status === "completed") {
    switch (result) {
      case "failed":
        return "failed";
      case "canceled":
        return "canceled";
      case "partiallySucceeded":
      case "succeededWithIssues":
        return "partial";
      default:
        return "succeeded";
    }
  }
  return "idle";
}

export function isActiveOutcome(outcome: BuildOutcome): boolean {
  return outcome === "running" || outcome === "queued" || outcome === "canceling";
}

export function outcomeLabel(outcome: BuildOutcome): string {
  switch (outcome) {
    case "running":
      return "Running";
    case "queued":
      return "Queued";
    case "canceling":
      return "Canceling";
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
    case "partial":
      return "Partial";
    case "canceled":
      return "Canceled";
    case "idle":
      return "No runs";
  }
}

export function safeBuildUrl(href: string | undefined, fallback: string): string | null {
  if (href && isAzureWebUrl(href)) return href;
  return isAzureWebUrl(fallback) ? fallback : null;
}

export function isAzureWebUrl(href: string): boolean {
  try {
    const url = new URL(href);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host === "dev.azure.com" || host.endsWith(".visualstudio.com");
  } catch {
    return false;
  }
}

export function summarizeTimeline(records: readonly TimelineRecordInput[]): {
  percent: number;
  stages: StageView[];
} {
  const latest = latestAttempts(records);
  const stages = stageViews(latest);
  let percent = percentComplete(latest);
  const stillOpen = stages.some((stage) => stage.status === "running" || stage.status === "waiting");
  if (stillOpen && percent === 100) percent = 99;
  return { percent, stages };
}

export function formatStatus(result: {
  status: "needs-setup" | "failed" | "ready";
  message?: string;
  scopeLabel?: string;
  notice?: string | null;
  pipelines?: PipelineView[];
  hiddenCount?: number;
}): string {
  if (result.status !== "ready") return `${result.message ?? "Pipeline status is unavailable."}\n`;
  const lines: string[] = [result.scopeLabel ?? "", ""];
  if (result.notice) lines.push(result.notice, "");
  const pipelines = result.pipelines ?? [];
  if (pipelines.length === 0 && !result.notice) {
    lines.push("No pipeline is running.");
  }
  for (const pipeline of pipelines) {
    const branch = pipeline.branch ? `  ${pipeline.branch}` : "";
    lines.push(
      `${pipeline.name}  #${pipeline.buildNumber}  ${pipeline.percent}%  ${runLabel(pipeline.runStatus)}${branch}`,
    );
    if (pipeline.stagesNote) lines.push(`  ${pipeline.stagesNote}`);
    for (const stage of pipeline.stages) {
      lines.push(`  ${stage.name}  ${stageLabel(stage.status)}`);
    }
    lines.push("");
  }
  if ((result.hiddenCount ?? 0) > 0) {
    lines.push(`${result.hiddenCount} more running.`);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function stageLabel(status: StageStatus): string {
  switch (status) {
    case "waiting":
      return "Waiting";
    case "running":
      return "Running";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
    case "partial":
      return "Partial";
  }
}

export function runLabel(status: RunStatus): string {
  switch (status) {
    case "running":
      return "Running";
    case "queued":
      return "Queued";
    case "canceling":
      return "Canceling";
  }
}

export function parseAzureRemote(configText: string): AzureRepo | null {
  const urls = remoteUrls(configText);
  const origin = urls.find((entry) => entry.name === "origin");
  const ordered = origin ? [origin, ...urls.filter((entry) => entry !== origin)] : urls;
  for (const entry of ordered) {
    const parsed = parseAzureUrl(entry.url);
    if (parsed) return parsed;
  }
  return null;
}

export function parseAzureUrl(raw: string): AzureRepo | null {
  const cleaned = raw.trim().replace(/\.git$/i, "").replace(/[?#].*$/, "");
  const patterns = [
    /^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)$/i,
    /^https:\/\/([^.]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+)$/i,
    /^(?:ssh:\/\/)?(?:[^@/]+@)?ssh\.dev\.azure\.com(?::\d+)?[:/]v3\/([^/]+)\/([^/]+)\/([^/]+)$/i,
    /^(?:ssh:\/\/)?(?:[^@/]+@)?vs-ssh\.visualstudio\.com(?::\d+)?[:/]v3\/([^/]+)\/([^/]+)\/([^/]+)$/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(cleaned);
    if (!match) continue;
    const organization = safeSegment(match[1] ?? "");
    const project = safeSegment(match[2] ?? "");
    const repo = safeSegment(match[3] ?? "");
    if (!organization || !project || !repo) return null;
    return { organization, project, repo };
  }
  return null;
}

export function clip(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function latestAttempts(records: readonly TimelineRecordInput[]): TimelineRecordInput[] {
  const best = new Map<string, TimelineRecordInput>();
  const rest: TimelineRecordInput[] = [];
  for (const record of records) {
    const identifier = record.identifier?.trim();
    const type = record.type?.trim();
    if (!identifier || !type) {
      if (type) rest.push(record);
      continue;
    }
    const key = `${type}:${identifier}`;
    const current = best.get(key);
    if (!current || (record.attempt ?? 0) >= (current.attempt ?? 0)) {
      best.set(key, record);
    }
  }
  return [...best.values(), ...rest];
}

function percentComplete(records: readonly TimelineRecordInput[]): number {
  const stages = stageRecords(records);
  if (stages.length > 1) {
    let progress = 0;
    for (const stage of stages) {
      if (stage.state === "completed") {
        progress += 1;
        continue;
      }
      if (stage.state === "inProgress") {
        const reported = fraction(stage.percentComplete);
        progress += reported > 0 ? reported : 0.25;
      }
    }
    return Math.round(Math.min(100, (progress / stages.length) * 100));
  }
  const tasks = actionable(records, "Task");
  const units = tasks.length > 0 ? tasks : stages;
  if (units.length === 0) return 0;
  let progress = 0;
  for (const unit of units) {
    if (unit.state === "completed") {
      progress += 1;
      continue;
    }
    if (unit.state === "inProgress") progress += fraction(unit.percentComplete);
  }
  return Math.round(Math.min(100, (progress / units.length) * 100));
}

function stageViews(records: readonly TimelineRecordInput[]): StageView[] {
  return stageRecords(records)
    .slice()
    .sort((left, right) => (left.order ?? 1_000_000) - (right.order ?? 1_000_000))
    .flatMap((record) => {
      const status = stageStatus(record);
      if (status === "skipped") return [];
      return [{ name: clip(record.name?.trim() || "Unnamed", 80), status }];
    });
}

function stageRecords(records: readonly TimelineRecordInput[]): TimelineRecordInput[] {
  for (const type of STAGE_TYPES) {
    const matches = actionable(records, type);
    if (matches.length > 0) return matches;
  }
  return [];
}

function actionable(
  records: readonly TimelineRecordInput[],
  type: string,
): TimelineRecordInput[] {
  return records.filter((record) => record.type === type && record.result !== "skipped");
}

function fraction(percent: number | null | undefined): number {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent)) / 100;
}

function stageStatus(record: TimelineRecordInput): StageStatus | "skipped" {
  if (record.result === "skipped") return "skipped";
  if (record.state === "inProgress") return "running";
  if (record.state !== "completed") return "waiting";
  switch (record.result) {
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    case "partiallySucceeded":
    case "succeededWithIssues":
      return "partial";
    default:
      return "done";
  }
}

function remoteUrls(configText: string): { name: string; url: string }[] {
  const result: { name: string; url: string }[] = [];
  let remote: string | null = null;
  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[remote "([^"]+)"\]$/.exec(line);
    if (header?.[1]) {
      remote = header[1];
      continue;
    }
    if (line.startsWith("[")) {
      remote = null;
      continue;
    }
    if (!remote) continue;
    const url = /^url\s*=\s*(.+)$/.exec(line);
    if (url?.[1]) result.push({ name: remote, url: url[1].trim() });
  }
  return result;
}

function safeSegment(value: string): string | null {
  let decoded = value.trim();
  try {
    decoded = decodeURIComponent(value).trim();
  } catch {
    decoded = value.trim();
  }
  if (!decoded || decoded.includes("/") || decoded.includes("\\") || decoded.includes("..")) {
    return null;
  }
  return decoded;
}
