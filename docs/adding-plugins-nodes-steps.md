# Adding Plugins, Nodes, and Steps

This guide documents how to add a new integration plugin and action step so it appears as an action node in the workflow builder and runs correctly at execution time.

## How the System Works

- A plugin is a folder under `plugins/<integration-name>/`.
- Each plugin registers one integration (`registerIntegration(...)`) with one or more actions.
- Each action maps to a step file through:
  - `stepFunction` (exported function name)
  - `stepImportPath` (file name under `plugins/<integration>/steps/`)
- `pnpm discover-plugins` regenerates:
  - `plugins/index.ts` (auto-imports plugins)
  - `lib/step-registry.ts` (runtime step importer map)
  - `lib/types/integration.ts` (integration type union)
  - `lib/codegen-registry.ts` (generated templates from step handlers)

## Fastest Path: Scaffold a Plugin

Run:

```bash
pnpm create-plugin
```

This creates a plugin from `plugins/_template`.

After editing generated files, run:

```bash
pnpm discover-plugins
```

## Plugin File Structure

Expected files for a typical plugin:

- `plugins/<integration>/index.ts`
- `plugins/<integration>/credentials.ts`
- `plugins/<integration>/icon.tsx`
- `plugins/<integration>/test.ts` (or reuse another plugin's test function)
- `plugins/<integration>/steps/<action>.ts`

## 1) Define the Integration and Actions (`index.ts`)

In `plugins/<integration>/index.ts`:

- Set unique integration `type` (kebab-case, usually folder name).
- Add `formFields` for integration credentials.
- Register actions in `actions[]`.
- For each action:
  - set unique `slug`
  - set `stepFunction`
  - set `stepImportPath`
  - define `configFields` (these become node config keys in `node.data.config`)
  - optionally define `outputFields` for template autocomplete
- Call `registerIntegration(plugin)` at the end.

Use field types from `plugins/registry.ts`:

- `template-input`
- `template-textarea`
- `text`
- `number`
- `select`
- `schema-builder`
- `group` (for grouped fields)

## 2) Implement the Step (`steps/<action>.ts`)

Use this pattern:

1. Add `"server-only"` import.
2. Define `CoreInput` (the action config payload).
3. Implement `stepHandler(input, credentials)` with business logic.
4. Export step entry function with `"use step"` that:
   - fetches credentials from `integrationId`
   - wraps logic with `withStepLogging(...)`
5. Export `export const _integrationType = "<integration-type>"`.

Minimal shape:

```ts
import "server-only";

import { fetchCredentials } from "@/lib/credential-fetcher";
import { type StepInput, withStepLogging } from "@/lib/steps/step-handler";
import type { MyCredentials } from "../credentials";

export type MyActionCoreInput = {
  name: string;
};

export type MyActionInput = StepInput &
  MyActionCoreInput & {
    integrationId?: string;
  };

type MyActionResult =
  | { success: true; data: { id: string } }
  | { success: false; error: { message: string } };

async function stepHandler(
  input: MyActionCoreInput,
  credentials: MyCredentials
): Promise<MyActionResult> {
  const apiKey = credentials.MY_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      error: { message: "MY_API_KEY is not configured." },
    };
  }

  // Use fetch for outbound API calls.
  return { success: true, data: { id: "example-id" } };
}

export async function myActionStep(
  input: MyActionInput
): Promise<MyActionResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId)
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
myActionStep.maxRetries = 0;

export const _integrationType = "my-integration";
```

## 3) Credential and Test Files

- `credentials.ts`: define credential type keys by env-var name (for example `MY_API_KEY?: string`).
- `test.ts`: implement a lightweight auth check for "Test Connection" flow.

## 4) Add or Update Action Nodes in UI

No manual node registration is needed when the plugin action is registered correctly.

- Action picker reads plugin registry entries.
- Node config UI renders from `configFields`.
- Workflow execution resolves `config.actionType` via `lib/step-registry.ts`.

Node execution path:

1. User selects an action -> node gets `config.actionType`.
2. Executor resolves templates in config.
3. Executor loads step function from generated `lib/step-registry.ts`.
4. Step runs with `integrationId` and `_context`.

## 5) Required Commands After Changes

```bash
pnpm discover-plugins
pnpm type-check
pnpm fix
```

## Development Rules for This Repo

- Use `fetch` in plugin steps instead of API SDK client packages.
- Avoid plugin `dependencies` field unless absolutely necessary.
- Do not use server actions for app features; use API routes and `@/lib/api-client`.
- Keep step outputs in standardized format for new work:
  - success: `{ success: true, data: {...} }`
  - error: `{ success: false, error: { message: "..." } }`
- In plugin `outputFields`, use unwrapped field names (for example `"id"`, not `"data.id"`).

## Troubleshooting

- Action not visible in picker:
  - check plugin folder name, `type`, and `registerIntegration(...)`
  - run `pnpm discover-plugins`
- Runtime says unknown action type:
  - ensure `config.actionType` matches integration/slug
  - verify generated entry in `lib/step-registry.ts`
- Step function not found:
  - `stepFunction` in `index.ts` must exactly match exported function in step file
  - `stepImportPath` must match step file name
