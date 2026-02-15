/**
 * Code template for Run Workflow action step
 * This is a string template used for code generation - keep as string export
 */
export default `export async function runWorkflowStep(input: {
  targetWorkflowId: string;
  workflowInput?: string;
}) {
  "use step";

  if (input.workflowInput && input.workflowInput.trim() !== "") {
    try {
      const value = JSON.parse(input.workflowInput);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {
          success: false,
          error: { message: "workflowInput must be a JSON object" },
        };
      }
    } catch {
      return {
        success: false,
        error: { message: "workflowInput must be valid JSON" },
      };
    }
  }

  // This template is for exported projects and does not include the
  // Workflow Builder runtime orchestration layer needed for sub-workflows.
  return {
    success: false,
    error: {
      message:
        "Run Workflow requires the Workflow Builder runtime and is not available in standalone export.",
    },
  };
}`;
