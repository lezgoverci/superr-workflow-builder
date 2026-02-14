# Using Vercel AI SDK for Agentic Workflows

This guide shows how to build agentic workflow steps in this project using the Vercel AI SDK (`ai` package), with tool-calling loops and workflow-safe execution patterns.

Reference implementation: `plugins/ai-agent/steps/run-agent.ts`.

## Architecture in This Repo

The AI-agent step follows a layered pattern:

1. **Step entry** (`"use step"`):
  - receives workflow node input
  - fetches credentials by `integrationId`
  - wraps execution with `withStepLogging(...)`
2. **Core handler**:
  - validates inputs
  - builds model + tools
  - runs `ToolLoopAgent`
3. **Tool provider**:
  - creates sandbox-backed tools (`bash`, `readFile`, `writeFile`)
  - handles sandbox lifecycle/cleanup

This separates workflow concerns (logging, credentials, context) from agent logic.

## Minimal Agent Step Pattern

```ts
import "server-only";

import { createGateway, stepCountIs, ToolLoopAgent } from "ai";
import { fetchCredentials } from "@/lib/credential-fetcher";
import { type StepInput, withStepLogging } from "@/lib/steps/step-handler";

type RunResult =
  | { success: true; data: { text: string; stepsUsed: number } }
  | { success: false; error: { message: string } };

type CoreInput = {
  aiModel?: string;
  agentPrompt?: string;
  maxSteps?: string;
};

type StepInputType = StepInput &
  CoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  input: CoreInput,
  credentials: { AI_GATEWAY_API_KEY?: string }
): Promise<RunResult> {
  const apiKey = credentials.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      error: { message: "AI_GATEWAY_API_KEY is not configured." },
    };
  }
  if (!input.agentPrompt?.trim()) {
    return { success: false, error: { message: "Agent prompt is required." } };
  }

  const gateway = createGateway({ apiKey });
  const maxSteps = Math.min(Math.max(Number.parseInt(input.maxSteps || "10"), 1), 50);
  const model = input.aiModel || "anthropic/claude-sonnet-4.5";

  const { tools, cleanup } = await createToolsForAgent(input);
  try {
    const agent = new ToolLoopAgent({
      model: gateway(model),
      tools,
      stopWhen: stepCountIs(maxSteps),
    });

    const result = await agent.generate({ prompt: input.agentPrompt });
    return {
      success: true,
      data: { text: result.text, stepsUsed: result.steps.length },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    await cleanup();
  }
}

export async function runAgentStep(input: StepInputType): Promise<RunResult> {
  "use step";
  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId)
    : {};
  return withStepLogging(input, () => stepHandler(input, credentials));
}
```

## Model Routing

In this repo, model IDs are normalized to provider format (for example `anthropic/<model>`, `openai/<model>`). Keep this normalization centralized so UI can pass short values safely.

## Tooling Strategy

For agentic workflows, prefer explicit tool boundaries:

- `bash` for command execution
- `readFile` for bounded file reads
- `writeFile` for structured writes

Use `createBashTool(...)` and inject sandbox mode based on config.

## Prompt and Instruction Design

Recommended fields in action config:

- `agentPrompt` (required user task)
- `agentInstructions` (optional system policy)
- `maxSteps` (bounded loop budget)
- `aiModel` (model selection)

Keep defaults conservative. Bound `maxSteps` with hard min/max in code.

## Output Contract for Workflow Compatibility

For new agentic steps, use standardized outputs:

- success: `{ success: true, data: {...} }`
- error: `{ success: false, error: { message: "..." } }`

Template resolution in workflow execution already understands this structure and can auto-unwrap `data` fields for variable references.

In plugin `outputFields`, reference unwrapped fields (for example `text`, `stepsUsed`).

## Reliability and Safety Checklist

- Validate required credentials and prompt input before model call.
- Constrain steps (`stepCountIs(...)`) to prevent runaway loops.
- Cap/trim tool output if large.
- Use `try/catch/finally` and always release external resources.
- Return actionable error messages (not just generic failures).

## API Architecture Rule

When adding UI or backend features around agentic workflows in this project:

- use API routes
- call backend through `import { api } from "@/lib/api-client"`
- do not introduce Next.js server actions

## Suggested Next Enhancements

- add retry policy per tool call category (network vs parse errors)
- add allow/deny command policy hooks for `bash` tool
- add structured JSON mode for agent final output when downstream nodes require strict schemas
