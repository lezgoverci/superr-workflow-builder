import type { IntegrationPlugin } from "../registry";
import { registerIntegration } from "../registry";
import { AiAgentIcon } from "./icon";

const aiAgentPlugin: IntegrationPlugin = {
  type: "ai-agent",
  label: "AI Agent",
  description:
    "AI-powered agent that can write & run code, process data, and call APIs",

  icon: AiAgentIcon,

  formFields: [
    {
      id: "aiGatewayApiKey",
      label: "API Key",
      type: "password",
      placeholder: "Your AI Gateway API key",
      configKey: "apiKey",
      envVar: "AI_GATEWAY_API_KEY",
      helpText: "Uses the same AI Gateway API key. Get yours from ",
      helpLink: {
        text: "vercel.com/ai-gateway",
        url: "https://vercel.com/docs/ai-gateway/getting-started",
      },
    },
  ],

  testConfig: {
    getTestFunction: async () => {
      // Reuse the ai-gateway test since we use the same API key
      const { testAiGateway } = await import("../ai-gateway/test");
      return testAiGateway;
    },
  },

  dependencies: {
    ai: "^6.0.0",
    "bash-tool": "^1.3.14",
    "just-bash": "^2.9.8",
    "@vercel/sandbox": "^1.5.0",
    zod: "^4.1.12",
  },

  actions: [
    {
      slug: "run-agent",
      label: "Run Agent",
      description:
        "Execute an AI agent that can write & run code, process data using bash tools",
      category: "AI Agent",
      stepFunction: "runAgentStep",
      stepImportPath: "run-agent",
      outputFields: [
        { field: "text", description: "Agent's text response" },
        { field: "data", description: "Structured data from the agent" },
        {
          field: "stepsUsed",
          description: "Number of tool steps the agent took",
        },
      ],
      configFields: [
        {
          key: "aiModel",
          label: "Model",
          type: "select",
          defaultValue: "anthropic/claude-sonnet-4.5",
          options: [
            {
              value: "anthropic/claude-sonnet-4.5",
              label: "Claude Sonnet 4.5",
            },
            {
              value: "anthropic/claude-haiku-4.5",
              label: "Claude Haiku 4.5",
            },
            { value: "openai/gpt-5.2", label: "GPT-5.2" },
            { value: "openai/gpt-5.2-pro", label: "GPT-5.2 Pro" },
            { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
            { value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
            { value: "meta/llama-4-scout", label: "Llama 4 Scout" },
            { value: "meta/llama-4-maverick", label: "Llama 4 Maverick" },
          ],
        },
        {
          key: "sandboxType",
          label: "Sandbox",
          type: "select",
          defaultValue: "vercel",
          options: [
            { value: "vercel", label: "Vercel Sandbox (full)" },
            { value: "just-bash", label: "just-bash (simulated)" },
          ],
        },
        {
          key: "vercelSandboxToken",
          label: "Vercel Sandbox Token",
          type: "text",
          placeholder:
            "OIDC token recommended. For access tokens, set VERCEL_TEAM_ID and VERCEL_PROJECT_ID in server env.",
          showWhen: { field: "sandboxType", equals: "vercel" },
        },
        {
          key: "agentPrompt",
          label: "Agent Prompt",
          type: "template-textarea",
          placeholder:
            "Describe what the agent should do. Use {{NodeName.field}} to reference previous outputs.",
          rows: 6,
          example:
            'Parse the data in {{Webhook.body}} and extract all email addresses. Return them as a JSON array.',
          required: true,
        },
        {
          key: "agentInstructions",
          label: "System Instructions",
          type: "template-textarea",
          placeholder:
            "Optional: Custom system instructions for how the agent should behave",
          rows: 3,
        },
        {
          key: "maxSteps",
          label: "Max Steps",
          type: "select",
          defaultValue: "10",
          options: [
            { value: "3", label: "3 (quick)" },
            { value: "5", label: "5 (fast)" },
            { value: "10", label: "10 (default)" },
            { value: "20", label: "20 (thorough)" },
          ],
        },
      ],
    },
  ],
};

// Auto-register on import
registerIntegration(aiAgentPlugin);

export default aiAgentPlugin;
