import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOutcomeOf,
  folderLabel,
  formatStatus,
  parseAzureRemote,
  parseAzureUrl,
  summarizeTimeline,
} from "./ado";
import { readGitConfigText } from "./git-config";

test("percent uses stages when a pipeline has multiple stages", () => {
  const summary = summarizeTimeline([
    { type: "Task", identifier: "compile", attempt: 1, name: "Compile", state: "completed", result: "succeeded" },
    { type: "Stage", identifier: "build", name: "Build", state: "completed", result: "succeeded", order: 1 },
    { type: "Stage", identifier: "test", name: "Test", state: "inProgress", percentComplete: 50, order: 2 },
    { type: "Stage", identifier: "deploy", name: "Deploy", state: "pending", order: 3 },
  ]);
  assert.equal(summary.percent, 50);
  assert.deepEqual(
    summary.stages.map((stage) => `${stage.name} ${stage.status}`),
    ["Build done", "Test running", "Deploy waiting"],
  );
});

test("percent uses tasks and the latest attempt on a single-stage pipeline", () => {
  const summary = summarizeTimeline([
    { type: "Task", identifier: "compile", attempt: 1, name: "Compile", state: "completed", result: "failed" },
    { type: "Task", identifier: "compile", attempt: 2, name: "Compile", state: "completed", result: "succeeded" },
    { type: "Task", identifier: "test", attempt: 1, name: "Test", state: "inProgress", percentComplete: 50 },
    { type: "Task", identifier: "pack", attempt: 1, name: "Pack", state: "pending" },
    { type: "Task", identifier: "skip", attempt: 1, name: "Skip", state: "completed", result: "skipped" },
    { type: "Stage", identifier: "build", name: "Build", state: "inProgress", order: 1 },
  ]);
  assert.equal(summary.percent, 50);
});

test("a running stage keeps the percent under 100", () => {
  const summary = summarizeTimeline([
    { type: "Task", identifier: "done", name: "Done", state: "completed", result: "succeeded" },
    { type: "Stage", identifier: "build", name: "Build", state: "inProgress", order: 1 },
  ]);
  assert.equal(summary.percent, 99);
  assert.equal(summary.stages[0]?.status, "running");
});

test("percent falls back to stages when a pipeline has no tasks", () => {
  const summary = summarizeTimeline([
    { type: "Stage", name: "Build", state: "completed", result: "succeeded", order: 1 },
    { type: "Stage", name: "Deploy", state: "pending", order: 2 },
  ]);
  assert.equal(summary.percent, 50);
  assert.equal(summary.stages.length, 2);
});

test("hides skipped stages and keeps phase names when there is no stage", () => {
  const summary = summarizeTimeline([
    { type: "Phase", name: "Agent job", state: "inProgress", order: 1 },
    { type: "Phase", name: "Old", state: "completed", result: "skipped", order: 2 },
  ]);
  assert.deepEqual(summary.stages, [{ name: "Agent job", status: "running" }]);
});

test("parses Azure DevOps remotes and prefers origin", () => {
  const config = `
[remote "upstream"]
	url = https://dev.azure.com/other/Proj/_git/other
[remote "origin"]
	url = git@ssh.dev.azure.com:v3/acme/Web%20App/web-api.git
`;
  assert.deepEqual(parseAzureRemote(config), {
    organization: "acme",
    project: "Web App",
    repo: "web-api",
  });
});

test("parses https, visualstudio, and ssh urls", () => {
  assert.deepEqual(parseAzureUrl("https://dev.azure.com/org/project/_git/repo"), {
    organization: "org",
    project: "project",
    repo: "repo",
  });
  assert.deepEqual(
    parseAzureUrl("https://user:secret@dev.azure.com/org/project/_git/repo.git"),
    { organization: "org", project: "project", repo: "repo" },
  );
  assert.deepEqual(
    parseAzureUrl("https://org.visualstudio.com/DefaultCollection/project/_git/repo"),
    { organization: "org", project: "project", repo: "repo" },
  );
  assert.deepEqual(
    parseAzureUrl("ssh://git@ssh.dev.azure.com:22/v3/org/project/repo"),
    { organization: "org", project: "project", repo: "repo" },
  );
  assert.equal(parseAzureUrl("https://github.com/org/repo.git"), null);
});

test("reads worktree git config through commondir", async () => {
  const files = new Map<string, string>([
    ["/repo/wt/.git", "gitdir: /repo/.git/worktrees/wt\n"],
    ["/repo/.git/worktrees/wt/commondir", "../..\n"],
    ["/repo/.git/config", "[remote \"origin\"]\n\turl = https://dev.azure.com/org/project/_git/app\n"],
  ]);
  const config = await readGitConfigText(async (filePath) => files.get(filePath) ?? null, "/repo/wt");
  assert.equal(parseAzureRemote(config ?? "")?.repo, "app");
});

test("formats a ready pipeline list", () => {
  const text = formatStatus({
    status: "ready",
    scopeLabel: "app",
    notice: null,
    hiddenCount: 1,
    pipelines: [
      {
        id: 9,
        name: "ci",
        buildNumber: "1842",
        runStatus: "running",
        percent: 64,
        branch: "main",
        url: null,
        stagesNote: null,
        stages: [
          { name: "Build", status: "done" },
          { name: "Test", status: "running" },
        ],
      },
    ],
  });
  assert.match(text, /ci {2}#1842 {2}64% {2}Running {2}main/);
  assert.match(text, /Build {2}Done/);
  assert.match(text, /Test {2}Running/);
  assert.match(text, /1 more running/);
});

test("maps build status and result into outcomes and cleans folder paths", () => {
  assert.equal(buildOutcomeOf("inProgress", null), "running");
  assert.equal(buildOutcomeOf("notStarted", null), "queued");
  assert.equal(buildOutcomeOf("completed", "succeeded"), "succeeded");
  assert.equal(buildOutcomeOf("completed", "failed"), "failed");
  assert.equal(buildOutcomeOf("completed", "partiallySucceeded"), "partial");
  assert.equal(buildOutcomeOf("completed", "canceled"), "canceled");
  assert.equal(buildOutcomeOf(null, null), "idle");
  assert.equal(folderLabel("\\Web App"), "Web App");
  assert.equal(folderLabel("\\"), "Root");
});
