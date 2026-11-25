import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const stageSchema = z
  .object({
    name: z.string(),
    status: z.enum(["waiting", "running", "done", "failed", "canceled", "partial"]),
  })
  .strict();

const outcomeSchema = z.enum([
  "running",
  "queued",
  "canceling",
  "succeeded",
  "failed",
  "partial",
  "canceled",
  "idle",
]);

const pipelineSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    buildNumber: z.string(),
    runStatus: z.enum(["running", "queued", "canceling"]),
    percent: z.number().int().min(0).max(100),
    branch: z.string().nullable(),
    url: z.string().nullable(),
    stages: z.array(stageSchema),
    stagesNote: z.string().nullable(),
  })
  .strict();

const latestRunSchema = z
  .object({
    id: z.number().int(),
    buildNumber: z.string(),
    outcome: outcomeSchema,
    branch: z.string().nullable(),
    queueTime: z.string().nullable(),
    finishTime: z.string().nullable(),
    url: z.string().nullable(),
  })
  .strict();

const definitionSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    folder: z.string(),
    url: z.string().nullable(),
    activeCount: z.number().int().nonnegative(),
    latestRun: latestRunSchema.nullable(),
  })
  .strict();

const runSummarySchema = z
  .object({
    id: z.number().int(),
    definitionId: z.number().int(),
    definitionName: z.string(),
    buildNumber: z.string(),
    outcome: outcomeSchema,
    branch: z.string().nullable(),
    requestedBy: z.string().nullable(),
    queueTime: z.string().nullable(),
    startTime: z.string().nullable(),
    finishTime: z.string().nullable(),
    url: z.string().nullable(),
    percent: z.number().int().min(0).max(100).nullable(),
    stages: z.array(stageSchema).nullable(),
    stagesNote: z.string().nullable(),
  })
  .strict();

const needsSetupSchema = z
  .object({
    status: z.literal("needs-setup"),
    message: z.string(),
  })
  .strict();

const failedSchema = z
  .object({
    status: z.literal("failed"),
    message: z.string(),
    organization: z.string(),
    project: z.string(),
  })
  .strict();

const readyStatusSchema = z
  .object({
    status: z.literal("ready"),
    organization: z.string(),
    project: z.string(),
    repoName: z.string().nullable(),
    pipelineFilter: z.string(),
    scopeLabel: z.string(),
    notice: z.string().nullable(),
    pipelines: z.array(pipelineSchema),
    hiddenCount: z.number().int().nonnegative(),
    checkedAt: z.string(),
  })
  .strict();

export const statusResultSchema = z.discriminatedUnion("status", [
  needsSetupSchema,
  failedSchema,
  readyStatusSchema,
]);

export const definitionsResultSchema = z.discriminatedUnion("status", [
  needsSetupSchema,
  failedSchema,
  z
    .object({
      status: z.literal("ready"),
      organization: z.string(),
      project: z.string(),
      scopeLabel: z.string(),
      definitions: z.array(definitionSchema),
      defaultIds: z.array(z.number().int().positive()),
      activeTotal: z.number().int().nonnegative(),
      checkedAt: z.string(),
    })
    .strict(),
]);

export const runsResultSchema = z.discriminatedUnion("status", [
  needsSetupSchema,
  failedSchema,
  z
    .object({
      status: z.literal("ready"),
      organization: z.string(),
      project: z.string(),
      definitionId: z.number().int(),
      definitionName: z.string(),
      folder: z.string(),
      definitionUrl: z.string().nullable(),
      runs: z.array(runSummarySchema),
      checkedAt: z.string(),
    })
    .strict(),
]);

export const runDetailResultSchema = z.discriminatedUnion("status", [
  needsSetupSchema,
  failedSchema,
  z
    .object({
      status: z.literal("ready"),
      organization: z.string(),
      project: z.string(),
      run: runSummarySchema,
      checkedAt: z.string(),
    })
    .strict(),
]);

export const rpcContract = defineRpcContract({
  status: {
    input: z.object({ environmentId: z.string().min(1).nullable() }).strict(),
    output: statusResultSchema,
  },
  definitions: {
    input: z.object({ environmentId: z.string().min(1).nullable() }).strict(),
    output: definitionsResultSchema,
  },
  runs: {
    input: z
      .object({
        environmentId: z.string().min(1).nullable(),
        definitionId: z.number().int().positive(),
      })
      .strict(),
    output: runsResultSchema,
  },
  run: {
    input: z
      .object({
        environmentId: z.string().min(1).nullable(),
        buildId: z.number().int().positive(),
      })
      .strict(),
    output: runDetailResultSchema,
  },
  setDefaults: {
    input: z
      .object({
        environmentId: z.string().min(1).nullable(),
        definitionIds: z.array(z.number().int().positive()).max(500),
      })
      .strict(),
    output: z
      .object({
        defaultIds: z.array(z.number().int().positive()),
      })
      .strict(),
  },
});
