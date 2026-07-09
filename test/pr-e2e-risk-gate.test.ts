// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchRiskWorkflow } from "../tools/e2e-advisor/post-merge-risk-gate.mts";
import { advisorJobs } from "../tools/e2e-advisor/pr-risk-gate.mts";

const temporaryDirectories: string[] = [];

function artifact(result: unknown): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "required-live-advisor-"));
  temporaryDirectories.push(directory);
  fs.writeFileSync(
    path.join(directory, "e2e-target-advisor-result.json"),
    `${JSON.stringify(result)}\n`,
    { mode: 0o600 },
  );
  const changedFiles = (result as { changedFiles?: string[] }).changedFiles ?? [];
  fs.writeFileSync(
    path.join(directory, "risk-plan.json"),
    `${JSON.stringify({ headSha: "a".repeat(40), changedFiles })}\n`,
    { mode: 0o600 },
  );
  return directory;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("required-live PR plan", () => {
  it("uses exact-head required jobs and reports selectors that need expansion", () => {
    const changedFiles = ["src/lib/onboard.ts"];
    const directory = artifact({
      version: 1,
      changedFiles,
      required: [
        { id: "onboard-resume", selectorType: "job", required: true },
        { id: "ubuntu-repo-cloud-openclaw", selectorType: "target", required: true },
        { id: "optional-by-contract", selectorType: "job", required: false },
      ],
    });

    expect(advisorJobs(directory, "a".repeat(40), changedFiles)).toEqual({
      jobs: ["onboard-resume"],
      unsupported: ["ubuntu-repo-cloud-openclaw"],
    });
  });

  it("rejects an Advisor artifact from another revision", () => {
    const directory = artifact({
      version: 1,
      changedFiles: ["src/lib/other.ts"],
      required: [],
    });

    expect(() => advisorJobs(directory, "a".repeat(40), ["src/lib/onboard.ts"])).toThrow(
      "Advisor result does not match the exact-head risk plan",
    );
  });

  it("binds a PR dispatch to its exact revision and cancellation group", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          workflow_run_id: 91,
          run_url: "https://api.github.com/repos/NVIDIA/NemoClaw/actions/runs/91",
          html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/91",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      dispatchRiskWorkflow({
        repository: "NVIDIA/NemoClaw",
        token: "token",
        jobs: ["onboard-resume"],
        commitSha: "a".repeat(40),
        planHash: "b".repeat(64),
        correlationId: "12345678-1234-4123-8123-123456789abc",
        prNumber: 42,
      }),
    ).resolves.toBe(91);

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      ref: "main",
      inputs: {
        checkout_sha: "a".repeat(40),
        jobs: "onboard-resume",
        pr_number: "42",
        risk_pr: "true",
        risk_shadow: "true",
      },
    });
  });
});
