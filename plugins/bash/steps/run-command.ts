import "server-only";

import { Sandbox as VercelSandbox } from "@vercel/sandbox";
import { createBashTool } from "bash-tool";
import { type StepInput, withStepLogging } from "@/lib/steps/step-handler";
import { getErrorMessageAsync } from "@/lib/utils";

type SandboxType = "vercel" | "just-bash";

type RunBashError = {
  message: string;
  command?: string;
  sandboxType?: SandboxType;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
};

type RunBashResult =
  | {
      success: true;
      data: {
        command: string;
        sandboxType: SandboxType;
        stdout: string;
        stderr: string;
        exitCode: number;
      };
    }
  | {
      success: false;
      error: RunBashError;
    };

export type RunBashCoreInput = {
  sandboxType?: string;
  oidcToken?: string;
  vercelSandboxToken?: string;
  command?: string;
};

export type RunBashInput = StepInput & RunBashCoreInput;

type VercelSandboxCredentials = {
  token: string;
  teamId: string;
  projectId: string;
};

type BashSandbox = Awaited<ReturnType<typeof createBashTool>>["sandbox"];

function getSandboxType(rawSandboxType: string | undefined): SandboxType {
  if (rawSandboxType === "vercel") {
    return "vercel";
  }

  return "just-bash";
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

function resolveOidcToken(
  inputOidcToken: string | undefined,
  legacySandboxToken: string | undefined
): string {
  const tokenFromInput = inputOidcToken?.trim() || legacySandboxToken?.trim();
  if (tokenFromInput) {
    return tokenFromInput;
  }

  throw new Error(
    "OIDC token is required when Sandbox is set to Vercel Sandbox."
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

async function createSandboxExecutor(input: RunBashCoreInput): Promise<{
  sandboxType: SandboxType;
  sandbox: BashSandbox;
  workingDirectory: string;
  cleanup: () => Promise<void>;
}> {
  const sandboxType = getSandboxType(input.sandboxType);

  if (sandboxType === "just-bash") {
    const { sandbox } = await createBashTool();
    return {
      sandboxType,
      sandbox,
      workingDirectory: "/workspace",
      cleanup: async () => {},
    };
  }

  const token = resolveOidcToken(input.oidcToken, input.vercelSandboxToken);
  const credentials = resolveVercelSandboxCredentials(token);
  const sandbox = await VercelSandbox.create(credentials);
  const destination = await resolveVercelSandboxDestination(sandbox);
  const { sandbox: wrappedSandbox } = await createBashTool({
    sandbox,
    destination,
  });

  return {
    sandboxType,
    sandbox: wrappedSandbox,
    workingDirectory: destination,
    cleanup: async () => {
      await sandbox.stop();
    },
  };
}

async function stepHandler(input: RunBashCoreInput): Promise<RunBashResult> {
  const command = input.command?.trim();
  if (!command) {
    return {
      success: false,
      error: {
        message: "Bash command is required.",
      },
    };
  }

  let cleanup = async () => {};
  let sandboxType = getSandboxType(input.sandboxType);

  try {
    const runtime = await createSandboxExecutor(input);
    cleanup = runtime.cleanup;
    sandboxType = runtime.sandboxType;

    const escapedWorkingDirectory = runtime.workingDirectory.replace(/"/g, '\\"');
    const result = await runtime.sandbox.executeCommand(
      `cd "${escapedWorkingDirectory}" && ${command}`
    );

    if (result.exitCode !== 0) {
      return {
        success: false,
        error: {
          message: `Command exited with code ${result.exitCode}.`,
          command,
          sandboxType,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        },
      };
    }

    return {
      success: true,
      data: {
        command,
        sandboxType,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      },
    };
  } catch (error) {
    const message = await getErrorMessageAsync(error);
    return {
      success: false,
      error: {
        message: `Failed to execute command: ${message}`,
        command,
        sandboxType,
      },
    };
  } finally {
    try {
      await cleanup();
    } catch (cleanupError) {
      console.error("[bash] Failed to cleanup sandbox:", cleanupError);
    }
  }
}

export async function runBashCommandStep(
  input: RunBashInput
): Promise<RunBashResult> {
  "use step";

  return withStepLogging(input, () => stepHandler(input));
}
runBashCommandStep.maxRetries = 0;

export const _integrationType = "bash";
