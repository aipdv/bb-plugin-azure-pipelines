import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchBuildDetail,
  fetchDefinitionRuns,
  fetchDefinitions,
  fetchPipelineStatus,
} from "./client";

test("loads the checkout repo and keeps the token out of the URL", async () => {
  const urls: string[] = [];
  const auth: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    urls.push(url);
    auth.push(new Headers(init?.headers).get("authorization") ?? "");
    if (url.includes("/git/repositories/")) {
      return json({ id: "repo-1", name: "app" });
    }
    if (url.includes("statusFilter=inProgress")) {
      return json({
        value: [
          build(8, "old", "inProgress"),
          build(9, "ci", "inProgress"),
          build(10, "nightly", "inProgress"),
        ],
      });
    }
    if (url.includes("statusFilter=notStarted")) return json({ value: [] });
    if (url.endsWith("/builds/9/timeline?api-version=7.1")) {
      return json({
        records: [
          { type: "Stage", name: "Build", state: "completed", result: "succeeded", order: 1 },
          { type: "Task", name: "Compile", state: "completed", result: "succeeded", identifier: "compile" },
          { type: "Task", name: "Test", state: "pending", identifier: "test" },
        ],
      });
    }
    return json({ records: [] });
  };

  const outcome = await fetchPipelineStatus({
    organization: "acme",
    project: "Web App",
    auth: { type: "pat", secret: "secret-token" },
    repoName: "app",
    pipelineFilter: "ci",
    signal: new AbortController().signal,
    fetchImpl,
  });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.result.pipelines.length, 1);
  assert.equal(outcome.result.pipelines[0]?.name, "ci");
  assert.equal(outcome.result.pipelines[0]?.percent, 50);
  assert.equal(outcome.result.pipelines[0]?.stages[0]?.status, "done");
  assert.ok(urls.some((url) => url.includes("/Web%20App/_apis/git/repositories/app")));
  assert.ok(urls.some((url) => url.includes("repositoryId=repo-1")));
  assert.equal(urls.some((url) => url.includes("secret-token")), false);
  assert.ok(auth.every((header) => header.startsWith("Basic ") && !header.includes("secret-token")));
});

test("reports a refused token without the response body", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ message: "token secret-token is bad" }), { status: 401 });
  const outcome = await fetchPipelineStatus({
    organization: "acme",
    project: "Demo",
    auth: { type: "pat", secret: "secret-token" },
    repoName: null,
    pipelineFilter: "",
    signal: new AbortController().signal,
    fetchImpl,
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.message, /Build \(Read\)/);
  assert.equal(outcome.message.includes("secret-token"), false);
});

test("lists all pipeline definitions with active counts and fetches runs + build timeline", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/_apis/build/definitions?includeLatestBuilds=true")) {
      return json({
        value: [
          {
            id: 70,
            name: "WebApi DEV",
            path: "\\Services",
            latestBuild: {
              id: 100,
              buildNumber: "20261124.1",
              status: "completed",
              result: "succeeded",
              sourceBranch: "refs/heads/main",
            },
          },
          {
            id: 56,
            name: "Worker DEV",
            path: "\\Background",
            latestBuild: null,
          },
        ],
      });
    }
    if (url.includes("statusFilter=inProgress")) {
      return json({
        value: [
          {
            id: 101,
            buildNumber: "20261124.2",
            status: "inProgress",
            sourceBranch: "refs/heads/feat/x",
            definition: { id: 70, name: "WebApi DEV" },
          },
        ],
      });
    }
    if (url.includes("statusFilter=notStarted")) return json({ value: [] });
    if (url.includes("/_apis/build/definitions/70?")) {
      return json({ id: 70, name: "WebApi DEV", path: "\\Services" });
    }
    if (url.includes("definitions=70")) {
      return json({
        value: [
          {
            id: 101,
            buildNumber: "20261124.2",
            status: "inProgress",
            sourceBranch: "refs/heads/feat/x",
            requestedFor: { displayName: "Alex" },
            definition: { id: 70, name: "WebApi DEV" },
          },
          {
            id: 100,
            buildNumber: "20261124.1",
            status: "completed",
            result: "succeeded",
            sourceBranch: "refs/heads/main",
            definition: { id: 70, name: "WebApi DEV" },
          },
        ],
      });
    }
    if (url.endsWith("/_apis/build/builds/101?api-version=7.1")) {
      return json({
        id: 101,
        buildNumber: "20261124.2",
        status: "inProgress",
        sourceBranch: "refs/heads/feat/x",
        definition: { id: 70, name: "WebApi DEV" },
      });
    }
    if (url.endsWith("/builds/101/timeline?api-version=7.1")) {
      return json({
        records: [
          { type: "Stage", name: "Build", state: "completed", result: "succeeded", order: 1 },
          { type: "Stage", name: "Deploy", state: "inProgress", order: 2 },
        ],
      });
    }
    return json({ value: [] });
  };

  const auth = { type: "bearer" as const, token: "test-bearer-token-value" };
  const defs = await fetchDefinitions({
    organization: "acme",
    project: "Demo",
    auth,
    pipelineFilter: "",
    signal: new AbortController().signal,
    fetchImpl,
  });
  assert.equal(defs.ok, true);
  if (!defs.ok) return;
  assert.equal(defs.definitions.length, 2);
  assert.equal(defs.activeTotal, 1);
  assert.equal(defs.definitions[0]?.folder, "Background");
  assert.equal(defs.definitions[1]?.activeCount, 1);
  assert.equal(defs.definitions[1]?.latestRun?.outcome, "running");

  const runs = await fetchDefinitionRuns({
    organization: "acme",
    project: "Demo",
    definitionId: 70,
    auth,
    signal: new AbortController().signal,
    fetchImpl,
  });
  assert.equal(runs.ok, true);
  if (!runs.ok) return;
  assert.equal(runs.runs.length, 2);
  assert.equal(runs.runs[0]?.percent, 63);
  assert.equal(runs.runs[0]?.stages?.length, 2);
  assert.equal(runs.runs[1]?.percent, null);

  const detail = await fetchBuildDetail({
    organization: "acme",
    project: "Demo",
    buildId: 101,
    auth,
    signal: new AbortController().signal,
    fetchImpl,
  });
  assert.equal(detail.ok, true);
  if (!detail.ok) return;
  assert.equal(detail.run.percent, 63);
  assert.equal(detail.run.stages?.[1]?.status, "running");
});

function build(id: number, name: string, status: string) {
  return {
    id,
    buildNumber: String(id),
    status,
    sourceBranch: "refs/heads/main",
    definition: { name },
    _links: { web: { href: `https://dev.azure.com/acme/Demo/_build/results?buildId=${id}` } },
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
