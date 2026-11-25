# Azure Pipelines for BB

Browse Azure DevOps pipelines, pick your defaults, and track live run progress and stages in the BB thread side panel.

## Install

```sh
bb plugin install https://github.com/aipdv/bb-plugin-azure-pipelines
```

## Setup

1. Sign in with Azure CLI: `az login`.
2. Set defaults: `az devops configure --defaults organization=https://dev.azure.com/<org> project=<project>`.
3. Open a thread and select the **Pipelines** tab on the right side panel.

A personal access token with `Build (Read)` scope is optional in plugin settings.

## CLI

```sh
bb azure-pipelines status
bb azure-pipelines status --environment <env-id> --json
```
