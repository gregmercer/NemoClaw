// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { readYaml, type Workflow, type WorkflowStep } from "./helpers/e2e-workflow-contract";

const PATH = ".github/workflows/pr-e2e-risk-gate.yaml";

type CoordinatorWorkflow = Workflow & {
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
};

function namedStep(steps: WorkflowStep[] | undefined, name: string): WorkflowStep {
  const result = steps?.find((step) => step.name === name);
  expect(result, `missing ${name}`).toBeDefined();
  return result!;
}

describe("required-live PR coordinator workflow", () => {
  it("cancels superseded live runs as soon as a PR head changes", () => {
    const workflow = readYaml<CoordinatorWorkflow>(PATH);
    const job = workflow.jobs["cancel-superseded"];
    const cancel = namedStep(job.steps, "Cancel superseded required-live runs");

    expect(job.if).toContain("github.event_name == 'pull_request_target'");
    expect(cancel.env?.CURRENT_HEAD_SHA).toBe("${{ github.event.pull_request.head.sha }}");
    expect(cancel.run).toContain("--mode cancel");
    expect(cancel.run).toContain('--pr "$PR_NUMBER"');
  });

  it("dispatches only after exact-head CI and Advisor planning and always closes its check", () => {
    const workflow = readYaml<CoordinatorWorkflow>(PATH);
    const job = workflow.jobs.coordinate;
    const resolve = namedStep(job.steps, "Resolve exact PR and CI result");
    const advisor = namedStep(job.steps, "Wait for exact-head Advisor artifacts");
    const start = namedStep(job.steps, "Build exact-head plan and dispatch required live E2E");
    const finish = namedStep(job.steps, "Complete exact-head required-live check");
    const abandon = namedStep(job.steps, "Close required-live check after coordinator failure");

    expect(workflow.permissions).toEqual({
      actions: "write",
      checks: "write",
      contents: "read",
      "pull-requests": "read",
    });
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(true);
    expect(resolve.env?.HEAD_SHA).toBe("${{ github.event.workflow_run.head_sha }}");
    expect(advisor.if).toContain("steps.resolve.outputs.ci_green == 'true'");
    expect(advisor.run).toContain('--commit "$HEAD_SHA"');
    expect(start.if).toContain("always()");
    expect(start.run).toContain('--ci-green "${{ steps.resolve.outputs.ci_green }}"');
    expect(finish.if).toContain("always()");
    expect(finish.run).toContain("--mode finish");
    expect(abandon.if).toContain("steps.start.outcome == 'failure'");
    expect(abandon.run).toContain("--mode abandon");
  });
});
