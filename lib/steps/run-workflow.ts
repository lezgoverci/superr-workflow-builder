/**
 * Executable step function for Run Workflow action
 */
import "server-only";

import { and, eq } from "drizzle-orm";
import { start } from "workflow/api";
import { db } from "@/lib/db";
import { validateWorkflowIntegrations } from "@/lib/db/integrations";
import { workflowExecutions, workflows } from "@/lib/db/schema";
import { executeWorkflow } from "@/lib/workflow-executor.workflow";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";
import { type StepInput, withStepLogging } from "./step-handler";

const MAX_NESTED_DEPTH = 10;

type RunWorkflowMeta = {
  path: string[];
  parentExecutionId: string;
  parentWorkflowId: string;
};

type RunWorkflowError = {
  success: false;
  error: { message: string };
};

type RunWorkflowSuccess = {
  success: true;
  data: {
    workflowId: string;
    executionId: string;
    output: unknown;
  };
};

type RunWorkflowResult = RunWorkflowSuccess | RunWorkflowError;

export type RunWorkflowInput = StepInput & {
  targetWorkflowId?: string;
  workflowInput?: string;
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function buildError(message: string): RunWorkflowError {
  return {
    success: false,
    error: { message },
  };
}

function extractRunWorkflowMeta(value: unknown): RunWorkflowMeta | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const maybeMeta = (value as Record<string, unknown>).__runWorkflowMeta;
  if (!maybeMeta || typeof maybeMeta !== "object") {
    return null;
  }

  const maybeMetaRecord = maybeMeta as Record<string, unknown>;
  const rawPath = maybeMetaRecord.path;
  const path = Array.isArray(rawPath)
    ? rawPath.filter(
        (item: unknown): item is string => typeof item === "string"
      )
    : [];

  const parentExecutionId = maybeMetaRecord.parentExecutionId;
  const parentWorkflowId = maybeMetaRecord.parentWorkflowId;

  if (
    path.length === 0 ||
    typeof parentExecutionId !== "string" ||
    typeof parentWorkflowId !== "string"
  ) {
    return null;
  }

  return {
    path,
    parentExecutionId,
    parentWorkflowId,
  };
}

function parseWorkflowInput(
  workflowInput: unknown
):
  | { success: true; input: Record<string, unknown> }
  | { success: false; message: string } {
  if (
    workflowInput === undefined ||
    workflowInput === null ||
    workflowInput === ""
  ) {
    return { success: true, input: {} };
  }

  if (typeof workflowInput === "object" && !Array.isArray(workflowInput)) {
    return {
      success: true,
      input: workflowInput as Record<string, unknown>,
    };
  }

  if (typeof workflowInput !== "string") {
    return {
      success: false,
      message: "Workflow input must be a JSON object string.",
    };
  }

  if (workflowInput.trim() === "") {
    return { success: true, input: {} };
  }

  try {
    const parsed = JSON.parse(workflowInput);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        success: false,
        message: "Workflow input must be a JSON object.",
      };
    }
    return { success: true, input: parsed as Record<string, unknown> };
  } catch {
    return {
      success: false,
      message: "Workflow input must be valid JSON.",
    };
  }
}

function getParentPath(parentExecution: {
  workflowId: string;
  input: unknown;
}): string[] {
  const parentMeta = extractRunWorkflowMeta(parentExecution.input);
  if (parentMeta?.path.length) {
    return parentMeta.path;
  }
  return [parentExecution.workflowId];
}

function buildNextPath(
  parentPath: string[],
  targetWorkflowId: string
):
  | { success: true; path: string[] }
  | { success: false; error: RunWorkflowError } {
  if (parentPath.includes(targetWorkflowId)) {
    return {
      success: false,
      error: buildError(
        `Cycle detected: workflow "${targetWorkflowId}" is already in execution path.`
      ),
    };
  }

  const nextPath = [...parentPath, targetWorkflowId];
  if (nextPath.length > MAX_NESTED_DEPTH) {
    return {
      success: false,
      error: buildError(
        `Maximum nested workflow depth (${MAX_NESTED_DEPTH}) exceeded.`
      ),
    };
  }

  return { success: true, path: nextPath };
}

async function getValidatedChildWorkflow(
  targetWorkflowId: string,
  userId: string
): Promise<
  | {
      success: true;
      workflow: NonNullable<
        Awaited<ReturnType<typeof db.query.workflows.findFirst>>
      >;
    }
  | { success: false; error: RunWorkflowError }
> {
  const childWorkflow = await db.query.workflows.findFirst({
    where: and(
      eq(workflows.id, targetWorkflowId),
      eq(workflows.userId, userId)
    ),
  });

  if (!childWorkflow) {
    return {
      success: false,
      error: buildError("Target workflow not found or not accessible."),
    };
  }

  const validation = await validateWorkflowIntegrations(
    childWorkflow.nodes as WorkflowNode[],
    userId
  );
  if (!validation.valid) {
    return {
      success: false,
      error: buildError(
        "Target workflow contains invalid integration references."
      ),
    };
  }

  return { success: true, workflow: childWorkflow };
}

async function executeChildWorkflow(input: {
  targetWorkflowId: string;
  executionId: string;
  parentWorkflowId: string;
  userId: string;
  nextPath: string[];
  childWorkflow: NonNullable<
    Awaited<ReturnType<typeof db.query.workflows.findFirst>>
  >;
  triggerInput: Record<string, unknown>;
}): Promise<RunWorkflowResult> {
  const {
    targetWorkflowId,
    executionId,
    parentWorkflowId,
    userId,
    nextPath,
    childWorkflow,
    triggerInput,
  } = input;

  let childExecutionId: string | undefined;

  try {
    const childExecutionInput: Record<string, unknown> = {
      ...triggerInput,
      __runWorkflowMeta: {
        path: nextPath,
        parentExecutionId: executionId,
        parentWorkflowId,
      } satisfies RunWorkflowMeta,
    };

    const [childExecution] = await db
      .insert(workflowExecutions)
      .values({
        workflowId: targetWorkflowId,
        userId,
        status: "running",
        input: childExecutionInput,
      })
      .returning();

    childExecutionId = childExecution.id;

    const childRun = await start(executeWorkflow, [
      {
        nodes: childWorkflow.nodes as WorkflowNode[],
        edges: childWorkflow.edges as WorkflowEdge[],
        triggerInput,
        executionId: childExecution.id,
        workflowId: childWorkflow.id,
      },
    ]);

    await childRun.returnValue;

    const completedChildExecution = await db.query.workflowExecutions.findFirst(
      {
        where: eq(workflowExecutions.id, childExecution.id),
      }
    );

    if (!completedChildExecution) {
      return buildError("Child workflow execution record was not found.");
    }

    if (completedChildExecution.status !== "success") {
      return buildError(
        completedChildExecution.error || "Child workflow execution failed."
      );
    }

    return {
      success: true,
      data: {
        workflowId: childWorkflow.id,
        executionId: childExecution.id,
        output: completedChildExecution.output,
      },
    };
  } catch (error) {
    const errorMessage = getErrorMessage(error);

    if (childExecutionId) {
      await db
        .update(workflowExecutions)
        .set({
          status: "error",
          error: errorMessage,
          completedAt: new Date(),
        })
        .where(eq(workflowExecutions.id, childExecutionId));
    }

    return buildError(`Run Workflow failed: ${errorMessage}`);
  }
}

async function runWorkflow(
  input: RunWorkflowInput
): Promise<RunWorkflowResult> {
  const targetWorkflowId = input.targetWorkflowId;
  const executionId = input._context?.executionId;
  if (!(targetWorkflowId && executionId)) {
    return buildError(
      targetWorkflowId
        ? "Run Workflow requires an execution context."
        : "Target workflow is required."
    );
  }

  const parsedInputResult = parseWorkflowInput(input.workflowInput);
  if (!parsedInputResult.success) {
    return buildError(parsedInputResult.message);
  }

  const parentExecution = await db.query.workflowExecutions.findFirst({
    where: eq(workflowExecutions.id, executionId),
  });

  if (!parentExecution) {
    return buildError("Parent workflow execution not found.");
  }

  const nextPathResult = buildNextPath(
    getParentPath(parentExecution),
    targetWorkflowId
  );
  if (!nextPathResult.success) {
    return nextPathResult.error;
  }

  const childWorkflowResult = await getValidatedChildWorkflow(
    targetWorkflowId,
    parentExecution.userId
  );
  if (!childWorkflowResult.success) {
    return childWorkflowResult.error;
  }

  return executeChildWorkflow({
    targetWorkflowId,
    executionId,
    parentWorkflowId: parentExecution.workflowId,
    userId: parentExecution.userId,
    nextPath: nextPathResult.path,
    childWorkflow: childWorkflowResult.workflow,
    triggerInput: parsedInputResult.input,
  });
}

// biome-ignore lint/suspicious/useAwait: workflow "use step" requires async
export async function runWorkflowStep(
  input: RunWorkflowInput
): Promise<RunWorkflowResult> {
  "use step";
  return withStepLogging(input, () => runWorkflow(input));
}
runWorkflowStep.maxRetries = 0;
