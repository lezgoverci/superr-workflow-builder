/**
 * AI Agent Step - Run Agent
 *
 * Uses AI SDK's generateText with tools (bash, readFile, writeFile)
 * from bash-tool to create an agentic loop where the LLM can
 * write & execute code, process data, and return results.
 */
import "server-only";

import { createGateway, generateText, stepCountIs } from "ai";
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

  try {
    const gateway = createGateway({ apiKey });

    // Create bash-tool sandbox (uses just-bash locally)
    const { tools: sandboxTools } = await createBashTool();

    const result = await generateText({
      model: gateway(modelString),
      system: input.agentInstructions || DEFAULT_INSTRUCTIONS,
      prompt: promptText,
      tools: sandboxTools,
      stopWhen: stepCountIs(maxSteps),
    });

    const data = parseAgentOutput(result.text, result.steps);

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
