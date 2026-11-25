---
name: azure-pipelines
description: Browse Azure DevOps pipelines, check running builds, percent complete, and stage status from the Pipelines side panel or the bb azure-pipelines CLI. Use when the user asks about an Azure DevOps build, pipeline, or stage.
---

# Azure Pipelines

The Pipelines tab in the thread side panel lists all Azure DevOps pipelines in your project, lets you pick default pipelines, and drills down into pipeline runs and live stage progress.

The running summary is also available from the CLI.

## Setup

1. Sign in with Azure CLI: `az login`.
2. Set the default organization and project with `az devops configure --defaults organization=https://dev.azure.com/<org> project=<project>`.
3. Leave the plugin organization and project empty to use the checkout remote or Azure CLI defaults.
4. Use **Pick** in the Pipelines tab to choose which pipelines show on the **Default** tab.

A personal access token in Settings is optional. Do not put a token in chat or in a command line.

## Command

`bb azure-pipelines status`

Options:

- `--environment <id>` limits the list to that checkout's repo.
- `--json` prints the status payload.

## Read the result

- `Running` is an in-progress build. `Queued` is not started.
- Multi-stage pipelines calculate percent from stage completion; single-stage pipelines calculate from tasks.
- Stage lines are Stage records. A classic pipeline uses Phase, then Job.
- Skipped stages are omitted.
