import { useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_useRpcQuery,
  useRpc,
  UrlLink,
} from "@get-bb/plugin-sdk/app";
import type { ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  isActiveOutcome,
  outcomeLabel,
  stageLabel,
  type BuildOutcome,
  type DefinitionSummary,
  type RunSummary,
  type StageStatus,
} from "./src/ado";
import { rpcContract } from "./src/contract";

const LIST_POLL_MS = 30_000;
const ACTIVE_POLL_MS = 15_000;
const RUN_POLL_MS = 10_000;

type PanelView =
  | { kind: "list" }
  | { kind: "definition"; definitionId: number; name: string }
  | {
      kind: "run";
      buildId: number;
      definitionId: number;
      definitionName: string;
      buildNumber: string;
    };

type ListFilter = "default" | "all" | "running";

function PipelinesPanel({ environment }: ExperimentalThreadTabProps) {
  const environmentId = environment?.id ?? null;
  const [view, setView] = useState<PanelView>({ kind: "list" });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ListFilter | null>(null);
  const [editingDefaults, setEditingDefaults] = useState(false);
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});

  if (view.kind === "definition") {
    return (
      <DefinitionRunsView
        environmentId={environmentId}
        definitionId={view.definitionId}
        fallbackName={view.name}
        onBack={() => setView({ kind: "list" })}
        onOpenRun={(run) =>
          setView({
            kind: "run",
            buildId: run.id,
            definitionId: view.definitionId,
            definitionName: run.definitionName || view.name,
            buildNumber: run.buildNumber,
          })
        }
      />
    );
  }

  if (view.kind === "run") {
    return (
      <RunDetailView
        environmentId={environmentId}
        buildId={view.buildId}
        fallbackName={view.definitionName}
        fallbackBuildNumber={view.buildNumber}
        onBack={() =>
          setView({
            kind: "definition",
            definitionId: view.definitionId,
            name: view.definitionName,
          })
        }
      />
    );
  }

  return (
    <DefinitionsListView
      environmentId={environmentId}
      search={search}
      onSearch={setSearch}
      filter={filter}
      onFilter={setFilter}
      editingDefaults={editingDefaults}
      onEditingDefaults={setEditingDefaults}
      collapsedFolders={collapsedFolders}
      onToggleFolder={(folder) =>
        setCollapsedFolders((current) => ({ ...current, [folder]: !current[folder] }))
      }
      onOpenDefinition={(definition) =>
        setView({ kind: "definition", definitionId: definition.id, name: definition.name })
      }
    />
  );
}

function DefinitionsListView({
  environmentId,
  search,
  onSearch,
  filter,
  onFilter,
  editingDefaults,
  onEditingDefaults,
  collapsedFolders,
  onToggleFolder,
  onOpenDefinition,
}: {
  environmentId: string | null;
  search: string;
  onSearch: (value: string) => void;
  filter: ListFilter | null;
  onFilter: (value: ListFilter) => void;
  editingDefaults: boolean;
  onEditingDefaults: (value: boolean) => void;
  collapsedFolders: Record<string, boolean>;
  onToggleFolder: (folder: string) => void;
  onOpenDefinition: (definition: DefinitionSummary) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const query = experimental_useRpcQuery({
    contract: rpcContract,
    method: "definitions",
    input: { environmentId },
  });
  useVisiblePoll(query.refetch, LIST_POLL_MS, !editingDefaults);

  const serverDefaultIds = query.data?.status === "ready" ? query.data.defaultIds : null;
  const [draftDefaultIds, setDraftDefaultIds] = useState<number[] | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const serverDefaultKey = serverDefaultIds ? serverDefaultIds.join(",") : "";
  useEffect(() => {
    setDraftDefaultIds(null);
  }, [serverDefaultKey]);

  const defaultIds = draftDefaultIds ?? serverDefaultIds ?? [];
  const defaultSet = useMemo(() => new Set(defaultIds), [defaultIds]);

  const definitions = query.data?.status === "ready" ? query.data.definitions : [];
  const validDefaultCount = useMemo(
    () => definitions.filter((item) => defaultSet.has(item.id)).length,
    [definitions, defaultSet],
  );
  const effectiveFilter: ListFilter =
    filter ?? (validDefaultCount > 0 ? "default" : "all");
  const activeFilter: ListFilter =
    effectiveFilter === "default" && validDefaultCount === 0 ? "all" : effectiveFilter;

  const runningDefs = useMemo(
    () => definitions.filter((item) => item.activeCount > 0),
    [definitions],
  );
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return definitions.filter((item) => {
      if (!editingDefaults) {
        if (activeFilter === "default" && !defaultSet.has(item.id)) return false;
        if (activeFilter === "running" && item.activeCount === 0) return false;
      }
      if (!term) return true;
      return (
        item.name.toLowerCase().includes(term) ||
        item.folder.toLowerCase().includes(term)
      );
    });
  }, [definitions, editingDefaults, activeFilter, defaultSet, search]);

  const grouped = useMemo(() => {
    const groups = new Map<string, DefinitionSummary[]>();
    for (const item of filtered) {
      const list = groups.get(item.folder);
      if (list) list.push(item);
      else groups.set(item.folder, [item]);
    }
    return [...groups.entries()];
  }, [filtered]);

  async function persistDefaults(nextIds: number[]) {
    const previous = draftDefaultIds;
    setDraftDefaultIds(nextIds);
    setSaveError(null);
    try {
      const saved = await rpc.call("setDefaults", {
        environmentId,
        definitionIds: nextIds,
      });
      setDraftDefaultIds(saved.defaultIds);
    } catch {
      setDraftDefaultIds(previous);
      setSaveError("Could not save default pipelines.");
    }
  }

  function toggleOne(definitionId: number) {
    const next = new Set(defaultIds);
    if (next.has(definitionId)) next.delete(definitionId);
    else next.add(definitionId);
    void persistDefaults([...next]);
  }

  function toggleFolderDefaults(items: readonly DefinitionSummary[]) {
    const next = new Set(defaultIds);
    const allSelected = items.every((item) => next.has(item.id));
    for (const item of items) {
      if (allSelected) next.delete(item.id);
      else next.add(item.id);
    }
    void persistDefaults([...next]);
  }

  if (query.data === undefined && query.isLoading) {
    return <PanelMessage text="Loading Azure DevOps pipelines…" />;
  }
  if (query.data === undefined) {
    return (
      <PanelError
        title="Pipelines are unavailable."
        detail={query.error?.message ?? "Try again."}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (query.data.status === "needs-setup" || query.data.status === "failed") {
    return (
      <PanelError
        title={query.data.message}
        onRetry={query.data.status === "failed" ? () => void query.refetch() : undefined}
      />
    );
  }

  const data = query.data;
  const checked = formatClock(data.checkedAt);
  const showRunningBanner =
    !editingDefaults &&
    activeFilter === "all" &&
    search.trim() === "" &&
    runningDefs.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b border-border/60 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
              PIPELINES
            </span>
            <span className="truncate rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {data.scopeLabel}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-1.5 text-[11px] text-muted-foreground"
            onClick={() => void query.refetch()}
          >
            {query.isFetching ? "Checking…" : checked || "Refresh"}
          </Button>
        </div>

        <div className="relative">
          <input
            type="text"
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder={
              editingDefaults
                ? "Search pipelines to toggle…"
                : "Filter pipelines or folders…"
            }
            aria-label="Filter pipelines or folders"
            className="h-7 w-full rounded-md border border-input bg-transparent pl-2.5 pr-7 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          {search ? (
            <button
              type="button"
              onClick={() => onSearch("")}
              aria-label="Clear filter"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-1 text-xs text-muted-foreground hover:text-foreground"
            >
              ×
            </button>
          ) : null}
        </div>

        {editingDefaults ? (
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[11px] text-muted-foreground">
              Default list: <strong className="font-medium text-foreground">{validDefaultCount}</strong> selected
            </span>
            <div className="flex shrink-0 items-center gap-1">
              {validDefaultCount > 0 ? (
                <button
                  type="button"
                  onClick={() => void persistDefaults([])}
                  className="rounded-md px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  Clear
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  onEditingDefaults(false);
                  onFilter(validDefaultCount > 0 ? "default" : "all");
                  void query.refetch();
                }}
                className="rounded-md bg-foreground px-2.5 py-0.5 text-[11px] font-medium text-background"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-1.5">
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {validDefaultCount > 0 ? (
                <FilterChip
                  active={activeFilter === "default"}
                  onClick={() => onFilter("default")}
                >
                  Default ({validDefaultCount})
                </FilterChip>
              ) : null}
              <FilterChip
                active={activeFilter === "all"}
                onClick={() => onFilter("all")}
              >
                All ({data.definitions.length})
              </FilterChip>
              <FilterChip
                active={activeFilter === "running"}
                onClick={() => onFilter("running")}
              >
                <span className="inline-flex items-center gap-1.5">
                  {runningDefs.length > 0 ? (
                    <span className="size-1.5 rounded-full bg-sky-500" />
                  ) : null}
                  Running ({runningDefs.length})
                </span>
              </FilterChip>
            </div>
            <button
              type="button"
              onClick={() => onEditingDefaults(true)}
              title="Toggle which pipelines show by default"
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <SlidersIcon />
              <span>Pick</span>
            </button>
          </div>
        )}

        {saveError ? <p className="text-[11px] text-destructive">{saveError}</p> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto pb-3">
        {showRunningBanner ? (
          <div className="border-b border-border/60 bg-muted/30 py-1.5">
            <div className="flex items-center justify-between px-3 pb-1 text-[11px] font-medium tracking-wide text-sky-600 dark:text-sky-400">
              <span>RUNNING NOW</span>
              <span className="tabular-nums">{data.activeTotal}</span>
            </div>
            {runningDefs.map((item) => (
              <DefinitionRow
                key={`running-${item.id}`}
                definition={item}
                showFolder
                onClick={() => onOpenDefinition(item)}
              />
            ))}
          </div>
        ) : null}

        {filtered.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            {activeFilter === "running" && !editingDefaults
              ? "No pipeline is running right now."
              : "No pipelines match this filter."}
          </p>
        ) : !editingDefaults && activeFilter === "default" ? (
          <div className="py-1">
            {filtered
              .slice()
              .sort((left, right) => {
                const leftActive = left.activeCount > 0 ? 0 : 1;
                const rightActive = right.activeCount > 0 ? 0 : 1;
                return (
                  leftActive - rightActive ||
                  left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
                );
              })
              .map((item) => (
                <DefinitionRow
                  key={item.id}
                  definition={item}
                  showFolder
                  onClick={() => onOpenDefinition(item)}
                />
              ))}
          </div>
        ) : (
          <div className="py-1">
            {grouped.map(([folder, items]) => {
              const forceOpen =
                editingDefaults || search.trim() !== "" || activeFilter === "running";
              const isOpen = forceOpen || !collapsedFolders[folder];
              const folderActive = items.some((item) => item.activeCount > 0);
              const folderAllPicked = items.every((item) => defaultSet.has(item.id));
              return (
                <div key={folder} className="mb-0.5">
                  <div className="flex h-7 w-full items-center gap-1.5 px-2.5 text-[11px] font-medium tracking-wide text-muted-foreground hover:bg-state-hover">
                    <button
                      type="button"
                      onClick={() => onToggleFolder(folder)}
                      aria-expanded={isOpen}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    >
                      <Chevron open={isOpen} />
                      <span className="min-w-0 flex-1 truncate">{folder}</span>
                      {folderActive && !editingDefaults ? (
                        <span className="size-1.5 shrink-0 rounded-full bg-sky-500" />
                      ) : null}
                      <span className="shrink-0 tabular-nums text-[10px] opacity-75">
                        {items.length}
                      </span>
                    </button>
                    {editingDefaults ? (
                      <button
                        type="button"
                        onClick={() => toggleFolderDefaults(items)}
                        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        {folderAllPicked ? "Hide all" : "Show all"}
                      </button>
                    ) : null}
                  </div>
                  {isOpen
                    ? items.map((item) =>
                        editingDefaults ? (
                          <DefinitionToggleRow
                            key={item.id}
                            definition={item}
                            checked={defaultSet.has(item.id)}
                            onToggle={() => toggleOne(item.id)}
                          />
                        ) : (
                          <DefinitionRow
                            key={item.id}
                            definition={item}
                            onClick={() => onOpenDefinition(item)}
                          />
                        ),
                      )
                    : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function DefinitionRow({
  definition,
  showFolder = false,
  onClick,
}: {
  definition: DefinitionSummary;
  showFolder?: boolean;
  onClick: () => void;
}) {
  const latest = definition.latestRun;
  const outcome: BuildOutcome = latest?.outcome ?? "idle";
  const when = formatRelative(latest?.finishTime ?? latest?.queueTime ?? null);
  const metaParts: string[] = [];
  if (showFolder) metaParts.push(definition.folder);
  if (latest?.branch) metaParts.push(latest.branch);
  if (when) metaParts.push(when);
  if (!latest) metaParts.push("No runs yet");

  return (
    <button
      type="button"
      onClick={onClick}
      title={definition.name}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-state-hover"
    >
      <OutcomeIcon outcome={outcome} />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium leading-tight">
          {definition.name}
        </span>
        <p className="truncate text-[11px] text-muted-foreground">
          {metaParts.join(" · ")}
        </p>
      </div>
      {definition.activeCount > 0 ? (
        <span className="shrink-0 rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium leading-none tabular-nums text-sky-600 dark:text-sky-400">
          {definition.activeCount > 1 ? `${definition.activeCount} running` : "Running"}
        </span>
      ) : null}
      <ChevronRight />
    </button>
  );
}

function DefinitionToggleRow({
  definition,
  checked,
  onToggle,
}: {
  definition: DefinitionSummary;
  checked: boolean;
  onToggle: () => void;
}) {
  const outcome: BuildOutcome = definition.latestRun?.outcome ?? "idle";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onToggle}
      title={definition.name}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-state-hover"
    >
      <OutcomeIcon outcome={outcome} />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-tight">
        {definition.name}
      </span>
      <span
        aria-hidden="true"
        className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
          checked ? "bg-sky-500" : "bg-muted-foreground/30"
        }`}
      >
        <span
          className={`inline-block size-3 rounded-full bg-background shadow-sm transition-transform ${
            checked ? "translate-x-3.5" : "translate-x-0.5"
          }`}
        />
      </span>
    </button>
  );
}

function DefinitionRunsView({
  environmentId,
  definitionId,
  fallbackName,
  onBack,
  onOpenRun,
}: {
  environmentId: string | null;
  definitionId: number;
  fallbackName: string;
  onBack: () => void;
  onOpenRun: (run: RunSummary) => void;
}) {
  const query = experimental_useRpcQuery({
    contract: rpcContract,
    method: "runs",
    input: { environmentId, definitionId },
  });
  const hasActive =
    query.data?.status === "ready" &&
    query.data.runs.some((run) => isActiveOutcome(run.outcome));
  useVisiblePoll(query.refetch, hasActive ? ACTIVE_POLL_MS : LIST_POLL_MS, true);

  const title = query.data?.status === "ready" ? query.data.definitionName : fallbackName;
  const folder = query.data?.status === "ready" ? query.data.folder : null;
  const definitionUrl = query.data?.status === "ready" ? query.data.definitionUrl : null;
  const checked = query.data?.status === "ready" ? formatClock(query.data.checkedAt) : "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-1.5 border-b border-border/60 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft />
            <span className="truncate">All pipelines</span>
          </button>
          <div className="flex shrink-0 items-center gap-1">
            {definitionUrl ? (
              <UrlLink
                href={definitionUrl}
                className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-state-hover hover:text-foreground"
              >
                ADO ↗
              </UrlLink>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px] text-muted-foreground"
              onClick={() => void query.refetch()}
            >
              {query.isFetching ? "Checking…" : checked || "Refresh"}
            </Button>
          </div>
        </div>
        <div>
          <h2 className="truncate text-[13px] font-semibold leading-snug" title={title}>
            {title}
          </h2>
          {folder ? <p className="truncate text-[11px] text-muted-foreground">{folder}</p> : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto pb-3">
        {query.data === undefined && query.isLoading ? (
          <PanelMessage text="Loading runs…" />
        ) : query.data === undefined ? (
          <PanelError
            title="Could not load runs."
            detail={query.error?.message ?? "Try again."}
            onRetry={() => void query.refetch()}
          />
        ) : query.data.status !== "ready" ? (
          <PanelError
            title={query.data.message}
            onRetry={query.data.status === "failed" ? () => void query.refetch() : undefined}
          />
        ) : query.data.runs.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            This pipeline has no runs yet.
          </p>
        ) : (
          <RunsList runs={query.data.runs} onOpenRun={onOpenRun} />
        )}
      </div>
    </div>
  );
}

function RunsList({
  runs,
  onOpenRun,
}: {
  runs: readonly RunSummary[];
  onOpenRun: (run: RunSummary) => void;
}) {
  const activeRuns = runs.filter((run) => isActiveOutcome(run.outcome));
  const recentRuns = runs.filter((run) => !isActiveOutcome(run.outcome));

  return (
    <div>
      {activeRuns.length > 0 ? (
        <div className="space-y-2 border-b border-border/60 bg-muted/25 p-3">
          <div className="text-[11px] font-medium tracking-wide text-sky-600 dark:text-sky-400">
            RUNNING ({activeRuns.length})
          </div>
          {activeRuns.map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => onOpenRun(run)}
              className="block w-full space-y-2 rounded-md border border-border/70 bg-background p-2.5 text-left hover:bg-state-hover"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <OutcomeIcon outcome={run.outcome} />
                    <span className="truncate text-xs font-medium">#{run.buildNumber}</span>
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {[run.branch, run.requestedBy, formatRelative(run.startTime ?? run.queueTime)]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                {run.percent !== null ? (
                  <span className="shrink-0 text-sm font-semibold tabular-nums">
                    {run.percent}%
                  </span>
                ) : null}
              </div>

              {run.percent !== null ? (
                <ProgressBar percent={run.percent} outcome={run.outcome} label={`#${run.buildNumber}`} />
              ) : null}

              {run.stages && run.stages.length > 0 ? (
                <ul className="space-y-1 pt-0.5">
                  {run.stages.map((stage, index) => (
                    <li
                      key={`${run.id}-${index}`}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <StageDot status={stage.status} />
                        <span className="truncate">{stage.name}</span>
                      </span>
                      <span className={stageClass(stage.status)}>{stageLabel(stage.status)}</span>
                    </li>
                  ))}
                </ul>
              ) : run.stagesNote ? (
                <p className="text-[11px] text-muted-foreground">{run.stagesNote}</p>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {recentRuns.length > 0 ? (
        <div className="py-1">
          <div className="px-3 pb-1 pt-2 text-[11px] font-medium tracking-wide text-muted-foreground">
            RECENT RUNS
          </div>
          {recentRuns.map((run) => {
            const meta = [
              run.branch,
              run.requestedBy,
              formatRelative(run.finishTime ?? run.queueTime),
            ].filter(Boolean);
            return (
              <button
                key={run.id}
                type="button"
                onClick={() => onOpenRun(run)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-state-hover"
              >
                <OutcomeIcon outcome={run.outcome} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[13px] font-medium">#{run.buildNumber}</span>
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {formatDuration(run.startTime, run.finishTime)}
                    </span>
                  </div>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {meta.join(" · ")}
                  </p>
                </div>
                <ChevronRight />
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function RunDetailView({
  environmentId,
  buildId,
  fallbackName,
  fallbackBuildNumber,
  onBack,
}: {
  environmentId: string | null;
  buildId: number;
  fallbackName: string;
  fallbackBuildNumber: string;
  onBack: () => void;
}) {
  const query = experimental_useRpcQuery({
    contract: rpcContract,
    method: "run",
    input: { environmentId, buildId },
  });
  const run = query.data?.status === "ready" ? query.data.run : null;
  const active = run ? isActiveOutcome(run.outcome) : false;
  useVisiblePoll(query.refetch, RUN_POLL_MS, active);

  const pipelineName = run?.definitionName || fallbackName;
  const buildNumber = run?.buildNumber || fallbackBuildNumber;
  const checked = query.data?.status === "ready" ? formatClock(query.data.checkedAt) : "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-1.5 border-b border-border/60 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft />
            <span className="truncate">{pipelineName}</span>
          </button>
          <div className="flex shrink-0 items-center gap-1">
            {run?.url ? (
              <UrlLink
                href={run.url}
                className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-state-hover hover:text-foreground"
              >
                ADO ↗
              </UrlLink>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px] text-muted-foreground"
              onClick={() => void query.refetch()}
            >
              {query.isFetching ? "Checking…" : checked || "Refresh"}
            </Button>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <h2 className="truncate text-[13px] font-semibold">#{buildNumber}</h2>
          {run ? <OutcomeBadge outcome={run.outcome} /> : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {query.data === undefined && query.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading run stages…</p>
        ) : query.data === undefined ? (
          <PanelError
            title="Could not load run."
            detail={query.error?.message ?? "Try again."}
            onRetry={() => void query.refetch()}
          />
        ) : query.data.status !== "ready" ? (
          <PanelError
            title={query.data.message}
            onRetry={query.data.status === "failed" ? () => void query.refetch() : undefined}
          />
        ) : (
          <div className="space-y-4">
            {query.data.run.percent !== null ? (
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xl font-semibold tabular-nums">
                    {query.data.run.percent}%
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {formatDuration(query.data.run.startTime, query.data.run.finishTime) ||
                      formatRelative(query.data.run.queueTime)}
                  </span>
                </div>
                <ProgressBar
                  percent={query.data.run.percent}
                  outcome={query.data.run.outcome}
                  label={`#${query.data.run.buildNumber}`}
                />
              </div>
            ) : null}

            <dl className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-2.5 text-xs">
              {query.data.run.branch ? (
                <MetaRow label="Branch" value={query.data.run.branch} />
              ) : null}
              {query.data.run.requestedBy ? (
                <MetaRow label="Triggered by" value={query.data.run.requestedBy} />
              ) : null}
              {query.data.run.queueTime ? (
                <MetaRow
                  label="Queued"
                  value={formatRelative(query.data.run.queueTime) || query.data.run.queueTime}
                />
              ) : null}
            </dl>

            <div className="space-y-2">
              <div className="text-[11px] font-medium tracking-wide text-muted-foreground">
                STAGES
              </div>
              {query.data.run.stagesNote ? (
                <p className="text-xs text-muted-foreground">{query.data.run.stagesNote}</p>
              ) : null}
              {query.data.run.stages && query.data.run.stages.length > 0 ? (
                <ul className="divide-y divide-border/50 rounded-md border border-border/60">
                  {query.data.run.stages.map((stage, index) => (
                    <li
                      key={`${buildId}-stage-${index}`}
                      className="flex items-center justify-between gap-3 px-2.5 py-2 text-xs"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <StageDot status={stage.status} />
                        <span className="truncate font-medium">{stage.name}</span>
                      </span>
                      <span className={stageClass(stage.status)}>{stageLabel(stage.status)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function useVisiblePoll(refetch: () => Promise<unknown>, ms: number, enabled: boolean) {
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refetchRef.current();
    }, ms);
    return () => window.clearInterval(timer);
  }, [ms, enabled]);
}

function PanelMessage({ text }: { text: string }) {
  return <p className="p-3 text-xs text-muted-foreground">{text}</p>;
}

function PanelError({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="space-y-2 p-3 text-xs">
      <p>{title}</p>
      {detail ? <p className="text-muted-foreground">{detail}</p> : null}
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${
        active
          ? "bg-foreground text-background"
          : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium" title={value}>
        {value}
      </dd>
    </div>
  );
}

function ProgressBar({
  percent,
  outcome,
  label,
}: {
  percent: number;
  outcome: BuildOutcome;
  label: string;
}) {
  const fill =
    outcome === "failed"
      ? "bg-destructive"
      : outcome === "succeeded"
        ? "bg-emerald-500"
        : outcome === "partial"
          ? "bg-amber-500"
          : "bg-sky-500";
  return (
    <div
      className="h-1.5 overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${label} ${percent} percent complete`}
    >
      <div className={`h-full transition-all ${fill}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: BuildOutcome }) {
  const tone =
    outcome === "running" || outcome === "canceling"
      ? "bg-sky-500/15 text-sky-600 dark:text-sky-400"
      : outcome === "queued"
        ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
        : outcome === "succeeded"
          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
          : outcome === "failed"
            ? "bg-destructive/15 text-destructive"
            : outcome === "partial"
              ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
              : "bg-muted text-muted-foreground";
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>
      {outcomeLabel(outcome)}
    </span>
  );
}

function OutcomeIcon({ outcome }: { outcome: BuildOutcome }) {
  if (outcome === "running" || outcome === "canceling") {
    return (
      <svg
        viewBox="0 0 16 16"
        className="size-3.5 shrink-0 animate-spin text-sky-500"
        aria-label={outcomeLabel(outcome)}
      >
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          d="M8 2a6 6 0 0 1 6 6"
        />
      </svg>
    );
  }
  if (outcome === "queued") {
    return (
      <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 text-amber-500" aria-label="Queued">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.75" />
        <path fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" d="M8 4.8V8l2.2 1.3" />
      </svg>
    );
  }
  if (outcome === "succeeded") {
    return (
      <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 text-emerald-500" aria-label="Succeeded">
        <circle cx="8" cy="8" r="6.5" fill="currentColor" opacity="0.16" />
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M5 8.2 7.1 10.3 11.2 5.8"
        />
      </svg>
    );
  }
  if (outcome === "failed") {
    return (
      <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 text-destructive" aria-label="Failed">
        <circle cx="8" cy="8" r="6.5" fill="currentColor" opacity="0.16" />
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          d="M5.5 5.5 10.5 10.5M10.5 5.5 5.5 10.5"
        />
      </svg>
    );
  }
  if (outcome === "partial") {
    return (
      <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 text-amber-500" aria-label="Partial">
        <circle cx="8" cy="8" r="6.5" fill="currentColor" opacity="0.16" />
        <path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" d="M8 4.8v3.7" />
        <circle cx="8" cy="11.2" r="1" fill="currentColor" />
      </svg>
    );
  }
  if (outcome === "canceled") {
    return (
      <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 text-muted-foreground" aria-label="Canceled">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="M5 11 11 5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 text-muted-foreground/60" aria-label="No runs">
      <circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function StageDot({ status }: { status: StageStatus }) {
  const color =
    status === "running"
      ? "bg-sky-500"
      : status === "done"
        ? "bg-emerald-500"
        : status === "failed"
          ? "bg-destructive"
          : status === "partial"
            ? "bg-amber-500"
            : "bg-muted-foreground/40";
  return <span className={`size-2 shrink-0 rounded-full ${color}`} aria-hidden="true" />;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
      aria-hidden="true"
    >
      <path fill="currentColor" d="M6 3.5 11 8 6 12.5z" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M6.2 4 10 8l-3.8 4"
      />
    </svg>
  );
}

function ChevronLeft() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 shrink-0" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.8 4 6 8l3.8 4"
      />
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3 shrink-0" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        d="M2.5 5h11M2.5 11h11"
      />
      <circle cx="6" cy="5" r="1.6" fill="currentColor" />
      <circle cx="10.5" cy="11" r="1.6" fill="currentColor" />
    </svg>
  );
}

function stageClass(status: StageStatus): string {
  if (status === "failed") return "shrink-0 font-medium text-destructive";
  if (status === "running") return "shrink-0 font-medium text-sky-600 dark:text-sky-400";
  if (status === "partial") return "shrink-0 text-amber-600 dark:text-amber-400";
  if (status === "done") return "shrink-0 text-emerald-600 dark:text-emerald-400";
  return "shrink-0 text-muted-foreground";
}

function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatRelative(iso: string | null): string {
  if (!iso) return "";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (diffSec < 60) return "just now";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(time).toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatDuration(startIso: string | null, finishIso: string | null): string {
  if (!startIso) return "";
  const start = Date.parse(startIso);
  const end = finishIso ? Date.parse(finishIso) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "";
  const totalSec = Math.floor((end - start) / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

export default definePluginApp((app) => {
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "fixed",
    id: "pipelines",
    title: "Pipelines",
    icon: "Activity",
    tooltip: "Azure DevOps pipelines",
    layout: "flush",
    component: PipelinesPanel,
  });
});
