/**
 * AI Agent Step - Run Agent
 *
 * Uses AI SDK's ToolLoopAgent with bash-tool tools (bash, readFile, writeFile)
 * so the model can iteratively reason and execute commands.
 */
import "server-only";

import { Sandbox as VercelSandbox } from "@vercel/sandbox";
import { createGateway, stepCountIs, ToolLoopAgent } from "ai";
import { createBashTool } from "bash-tool";
import { fetchCredentials } from "@/lib/credential-fetcher";
import { type StepInput, withStepLogging } from "@/lib/steps/step-handler";
import { getErrorMessageAsync } from "@/lib/utils";
import type { AiAgentCredentials } from "../credentials";

type RunAgentResult =
  | { success: true; text: string; stepsUsed: number; data?: unknown }
  | { success: false; error: string };

export type RunAgentCoreInput = {
  aiModel?: string;
  sandboxType?: string;
  vercelSandboxToken?: string;
  agentPrompt?: string;
  agentInstructions?: string;
  maxSteps?: string;
};

export type RunAgentInput = StepInput &
  RunAgentCoreInput & {
    integrationId?: string;
  };

/**
 * Gets the full model string in provider/model format.
 */
function getModelString(modelId: string): string {
  if (modelId.includes("/")) {
    return modelId;
  }

  if (modelId.startsWith("claude-")) {
    return `anthropic/${modelId}`;
  }
  if (modelId.startsWith("gpt-") || modelId.startsWith("o1-")) {
    return `openai/${modelId}`;
  }
  return `openai/${modelId}`;
}

/**
 * Attempt to parse stdout as JSON for structured output.
 * Falls back to raw text if parsing fails.
 */
function parseAgentOutput(
  text: string,
  steps: Array<{ toolCalls?: Array<{ toolName: string }> }>
): unknown {
  // Try to extract the last meaningful data from tool results
  // The agent's text response is the primary output
  const trimmed = text.trim();

  // Try to parse as JSON if it looks like JSON
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Not valid JSON, return as text
    }
  }

  return { text: trimmed, stepsUsed: steps.length };
}

type SandboxType = "vercel" | "just-bash";

type VercelSandboxCredentials = {
  token: string;
  teamId: string;
  projectId: string;
};

type SandboxTools = Awaited<ReturnType<typeof createBashTool>>["tools"];

function getSandboxType(sandboxType: string | undefined): SandboxType {
  if (sandboxType === "just-bash") {
    return "just-bash";
  }

  return "vercel";
}

function decodeBase64Url(base64Url: string): string {
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const paddingLength = (4 - (base64.length % 4)) % 4;
  const padded = `${base64}${"=".repeat(paddingLength)}`;
  return Buffer.from(padded, "base64").toString("utf-8");
}

function parseOidcTokenCredentials(
  token: string
): VercelSandboxCredentials | null {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    const payload = JSON.parse(decodeBase64Url(parts[1])) as {
      owner_id?: unknown;
      project_id?: unknown;
    };
    if (
      typeof payload.owner_id !== "string" ||
      typeof payload.project_id !== "string" ||
      payload.owner_id.trim() === "" ||
      payload.project_id.trim() === ""
    ) {
      return null;
    }

    return {
      token,
      teamId: payload.owner_id,
      projectId: payload.project_id,
    };
  } catch {
    return null;
  }
}

function resolveVercelSandboxCredentials(
  token: string
): VercelSandboxCredentials {
  const parsed = parseOidcTokenCredentials(token);
  if (parsed) {
    return parsed;
  }

  const teamId = process.env.VERCEL_TEAM_ID?.trim();
  const projectId = process.env.VERCEL_PROJECT_ID?.trim();

  if (teamId && projectId) {
    return {
      token,
      teamId,
      projectId,
    };
  }

  if (teamId || projectId) {
    throw new Error(
      "Both VERCEL_TEAM_ID and VERCEL_PROJECT_ID must be set together when using a non-OIDC Vercel token."
    );
  }

  throw new Error(
    "Invalid Vercel Sandbox token configuration. Provide an OIDC token or set VERCEL_TEAM_ID and VERCEL_PROJECT_ID in server environment variables."
  );
}

async function resolveVercelSandboxDestination(
  sandbox: VercelSandbox
): Promise<string> {
  const probeCommand = [
    "if [ -d /vercel/sandbox/workspace ]; then",
    "  printf '/vercel/sandbox/workspace'",
    "elif mkdir -p /vercel/sandbox/workspace >/dev/null 2>&1; then",
    "  printf '/vercel/sandbox/workspace'",
    "elif [ -d /workspace ]; then",
    "  printf '/workspace'",
    "elif [ -d /vercel/sandbox ]; then",
    "  printf '/vercel/sandbox'",
    "else",
    "  printf '/'",
    "fi",
  ].join("\n");

  const probeResult = await sandbox.runCommand("bash", ["-lc", probeCommand]);
  if (probeResult.exitCode !== 0) {
    const stderr = (await probeResult.stderr()).trim();
    throw new Error(
      `Failed to determine Vercel sandbox working directory${stderr ? `: ${stderr}` : "."}`
    );
  }

  const destination = (await probeResult.stdout()).trim();
  if (!destination) {
    throw new Error(
      "Failed to determine Vercel sandbox working directory: no destination returned."
    );
  }

  return destination;
}

async function createSandboxTools(input: RunAgentCoreInput): Promise<{
  tools: SandboxTools;
  cleanup: () => Promise<void>;
}> {
  const sandboxType = getSandboxType(input.sandboxType);

  if (sandboxType === "just-bash") {
    const { tools } = await createBashTool();
    return {
      tools,
      cleanup: async () => {},
    };
  }

  const token = input.vercelSandboxToken?.trim();
  if (!token) {
    throw new Error(
      "Vercel Sandbox token is required when Sandbox is set to Vercel Sandbox."
    );
  }

  const credentials = resolveVercelSandboxCredentials(token);
  const sandbox = await VercelSandbox.create(credentials);
  const destination = await resolveVercelSandboxDestination(sandbox);
  const { tools } = await createBashTool({
    sandbox,
    destination,
  });

  return {
    tools,
    cleanup: async () => {
      await sandbox.stop();
    },
  };
}

const DEFAULT_INSTRUCTIONS = `You are a helpful AI agent that can execute bash commands to accomplish tasks.
You have access to tools for running bash commands, reading files, and writing files in a sandboxed environment.
The sandbox has common utilities like jq, grep, sed, awk, sort, base64, and more.

When processing data:
- Write data to files, process with bash commands, read results
- Use jq for JSON processing
- Use standard unix tools for text processing
- Output your final result clearly

Always explain what you're doing briefly before executing commands.`;

/**
 * Core agent logic
 */
async function stepHandler(
  input: RunAgentCoreInput,
  credentials: AiAgentCredentials
): Promise<RunAgentResult> {
  const apiKey = credentials.AI_GATEWAY_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      error:
        "AI_GATEWAY_API_KEY is not configured. Please add it in Project Integrations.",
    };
  }

  const modelId = input.aiModel || "anthropic/claude-sonnet-4.5";
  const promptText = input.agentPrompt || "";

  if (!promptText || promptText.trim() === "") {
    return {
      success: false,
      error: "Agent prompt is required",
    };
  }

  const maxSteps = Math.min(
    Math.max(Number.parseInt(input.maxSteps || "10", 10) || 10, 1),
    50
  );
  const modelString = getModelString(modelId);
  let cleanup = async () => {};

  try {
    const gateway = createGateway({ apiKey });
    const { tools: sandboxTools, cleanup: sandboxCleanup } =
      await createSandboxTools(input);
    cleanup = sandboxCleanup;

    const agent = new ToolLoopAgent({
      model: gateway(modelString),
      tools: sandboxTools,
      instructions: input.agentInstructions || DEFAULT_INSTRUCTIONS,
      stopWhen: stepCountIs(maxSteps),
    });

    const result = await agent.generate({
      prompt: promptText,
    });

    const data = parseAgentOutput(
      result.text,
      result.steps as Array<{ toolCalls?: Array<{ toolName: string }> }>
    );

    return {
      success: true,
      text: result.text,
      stepsUsed: result.steps.length,
      data,
    };
  } catch (error) {
    const message = await getErrorMessageAsync(error);
    return {
      success: false,
      error: `Agent execution failed: ${message}`,
    };
  } finally {
    try {
      await cleanup();
    } catch (cleanupError) {
      console.error("[ai-agent] Failed to cleanup sandbox:", cleanupError);
    }
  }
}

/**
 * App entry point - fetches credentials and wraps with logging
 */
export async function runAgentStep(
  input: RunAgentInput
): Promise<RunAgentResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId)
    : {};

  return withStepLogging(input, () => stepHandler(input, credentials));
}
runAgentStep.maxRetries = 0;

export const _integrationType = "ai-agent";
