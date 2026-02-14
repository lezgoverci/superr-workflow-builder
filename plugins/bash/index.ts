import type { IntegrationPlugin } from "../registry";
import { registerIntegration } from "../registry";
import { BashIcon } from "./icon";

const bashPlugin: IntegrationPlugin = {
  type: "bash",
  label: "Bash",
  description:
    "Run bash commands in either local just-bash or remote Vercel Sandbox",

  icon: BashIcon,

  formFields: [],

  actions: [
    {
      slug: "run-command",
      label: "Run Command",
      description: "Execute a bash command in a selected sandbox runtime",
      category: "Bash",
      stepFunction: "runBashCommandStep",
      stepImportPath: "run-command",
      outputFields: [
        { field: "command", description: "The executed bash command" },
        { field: "sandboxType", description: "Sandbox used for execution" },
        { field: "stdout", description: "Standard output from the command" },
        { field: "stderr", description: "Standard error from the command" },
        { field: "exitCode", description: "Process exit code" },
      ],
      configFields: [
        {
          key: "sandboxType",
          label: "Sandbox",
          type: "select",
          defaultValue: "just-bash",
          options: [
            { value: "just-bash", label: "just-bash (local)" },
            { value: "vercel", label: "Vercel Sandbox (remote)" },
          ],
        },
        {
          key: "oidcToken",
          label: "OIDC Token",
          type: "text",
          placeholder:
            "OIDC token recommended. For access tokens, set VERCEL_TEAM_ID and VERCEL_PROJECT_ID in server env.",
          showWhen: { field: "sandboxType", equals: "vercel" },
        },
        {
          key: "command",
          label: "Bash Command",
          type: "template-textarea",
          placeholder:
            "echo \"hello world\"\nls -la\ncat ./file.txt | grep \"keyword\"",
          rows: 6,
          required: true,
          example: "printf 'hello\\nworld\\n' | wc -l",
        },
      ],
    },
  ],
};

registerIntegration(bashPlugin);

export default bashPlugin;
