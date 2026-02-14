# Building Features with Vercel Sandbox and just-bash

This guide explains how to implement workflow features that need command execution and file operations, with runtime support for both:

- `vercel` sandbox (full remote VM)
- `just-bash` (local simulated shell)

The reference implementation in this repo is `plugins/ai-agent/steps/run-agent.ts`.

## When to Use Each Sandbox

- Use `vercel` when you need:
  - real Linux environment
  - external binaries/runtime behavior
  - stronger isolation
- Use `just-bash` when you need:
  - faster/local execution
  - simple text/file transforms
  - no VM provisioning overhead

Expose this as an action config option (for example `sandboxType: "vercel" | "just-bash"`).

## Core Pattern

1. Parse user config and normalize sandbox type.
2. Create sandbox-backed bash tools.
3. Run feature logic using those tools.
4. Always cleanup remote sandbox resources.

## Implementation Template

```ts
import { Sandbox as VercelSandbox } from "@vercel/sandbox";
import { createBashTool } from "bash-tool";

type SandboxType = "vercel" | "just-bash";

function getSandboxType(raw?: string): SandboxType {
  return raw === "just-bash" ? "just-bash" : "vercel";
}

async function createSandboxTools(input: {
  sandboxType?: string;
  vercelSandboxToken?: string;
}) {
  const sandboxType = getSandboxType(input.sandboxType);

  if (sandboxType === "just-bash") {
    const { tools } = await createBashTool();
    return { tools, cleanup: async () => {} };
  }

  const token = input.vercelSandboxToken?.trim();
  if (!token) throw new Error("Vercel Sandbox token is required.");

  const sandbox = await VercelSandbox.create({
    token,
    teamId: process.env.VERCEL_TEAM_ID!,
    projectId: process.env.VERCEL_PROJECT_ID!,
  });

  const destination = await resolveVercelSandboxDestination(sandbox);
  const { tools } = await createBashTool({ sandbox, destination });

  return {
    tools,
    cleanup: async () => {
      await sandbox.stop();
    },
  };
}
```

## Important: Vercel Destination Path Gotcha

`bash-tool` defaults to `/vercel/sandbox/workspace` for `@vercel/sandbox`.

In some environments that directory does not exist yet, and `bash-tool` commands run as:

```bash
cd "<destination>" && <command>
```

If destination is missing, execution fails immediately.

Use a runtime probe/fallback before creating tools:

```ts
async function resolveVercelSandboxDestination(
  sandbox: VercelSandbox
): Promise<string> {
  const probe = [
    "if [ -d /vercel/sandbox/workspace ]; then",
    "  printf '/vercel/sandbox/workspace'",
    "elif mkdir -p /vercel/sandbox/workspace >/dev/null 2>&1; then",
    "  printf '/vercel/sandbox/workspace'",
    "elif [ -d /vercel/sandbox ]; then",
    "  printf '/vercel/sandbox'",
    "elif [ -d /workspace ]; then",
    "  printf '/workspace'",
    "else",
    "  printf '/'",
    "fi",
  ].join("\n");

  const result = await sandbox.runCommand("bash", ["-lc", probe]);
  if (result.exitCode !== 0) {
    throw new Error("Failed to resolve sandbox destination.");
  }
  return (await result.stdout()).trim();
}
```

## Credentials and Auth

For Vercel sandbox credentials:

- Prefer OIDC token (recommended).
- For non-OIDC access tokens, require:
  - `VERCEL_TEAM_ID`
  - `VERCEL_PROJECT_ID`

In this repo, credentials should be:

- fetched via `fetchCredentials(input.integrationId)` in step entry
- validated in core handler with explicit error messages

## Error Handling and Cleanup

Required guardrails:

- validate sandbox mode specific fields (for example token for `vercel`)
- wrap runtime in `try/catch/finally`
- always call cleanup in `finally` (`sandbox.stop()`)
- return workflow-friendly error output (structured and actionable)

## Config Fields Example

In plugin action config:

```ts
{
  key: "sandboxType",
  label: "Sandbox",
  type: "select",
  defaultValue: "vercel",
  options: [
    { value: "vercel", label: "Vercel Sandbox (full)" },
    { value: "just-bash", label: "just-bash (simulated)" }
  ]
},
{
  key: "vercelSandboxToken",
  label: "Vercel Sandbox Token",
  type: "text",
  showWhen: { field: "sandboxType", equals: "vercel" }
}
```

## Recommended Test Matrix

Validate both modes with the same core task:

1. basic command (`pwd`, `ls`)
2. file write/read (`writeFile`, `readFile`)
3. multiline bash script execution
4. expected failures (missing token, invalid command)
5. cleanup behavior (no leaked remote sandboxes)

## Operational Notes

- `just-bash` behavior differs from full VM for some binaries/tools.
- Prefer deterministic scripts and explicit command outputs.
- Keep command output bounded if feeding into model context.
