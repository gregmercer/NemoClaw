#!/usr/bin/env node

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { githubApi, githubRestPaginated } from "../advisors/github.mts";
import { parseArgs } from "../advisors/io.mts";
import { buildRiskPlan } from "../advisors/risk-plan.mts";
import { readFreeStandingJobsInventory } from "../e2e/workflow-boundary.mts";
import {
  changedFilesBetween,
  completeCheck,
  createCheck,
  dispatchRiskWorkflow,
  expectedRiskSignalShards,
  finishRiskGate,
  type RiskGateState,
  validateRiskPlan,
} from "./post-merge-risk-gate.mts";
import { readPrivateRegularFile, writePrivateRegularFile } from "./private-file.ts";

const CHECK_NAME = "E2E / Required Live";
const SHA = /^[a-f0-9]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const JOB = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

type Pull = {
  number: number;
  state: string;
  head: { sha: string; repo: { full_name: string } | null };
  base: { sha: string; repo: { full_name: string } };
};

type WorkflowRun = {
  id: number;
  display_title: string;
  status: string;
};

type TargetResult = {
  version: number;
  changedFiles: string[];
  required: Array<{ id: string; selectorType: string; required: boolean }>;
};

function tokenAndRepository(): { token: string; repository: string } {
  const token = process.env.GITHUB_TOKEN ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (!token || !REPOSITORY.test(repository)) throw new Error("trusted GitHub context is required");
  return { token, repository };
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function positive(value: string | undefined, name: string): number {
  const raw = required(value, name);
  if (!/^[1-9][0-9]*$/u.test(raw)) throw new Error(`--${name} must be a positive integer`);
  return Number(raw);
}

function output(name: string, value: string): void {
  if (
    !/^(?:base_sha|check_id|ci_green|dispatched|first_party|head_repo|head_sha|pr_number|run_id|state_hash)$/u.test(
      name,
    )
  ) {
    throw new Error("invalid output name");
  }
  const file = process.env.GITHUB_OUTPUT;
  if (!file || /[\r\n]/u.test(value)) throw new Error("safe GITHUB_OUTPUT is required");
  fs.appendFileSync(file, `${name}=${value}\n`, { encoding: "utf8" });
}

async function findExactPull(headSha: string, headRepo: string): Promise<Pull> {
  const { token, repository } = tokenAndRepository();
  if (!SHA.test(headSha) || !REPOSITORY.test(headRepo))
    throw new Error("invalid workflow head identity");
  const pulls = await githubRestPaginated<Pull>(`repos/${repository}/pulls?state=open`, token, 500);
  const matches = pulls.filter(
    (pull) =>
      pull.state === "open" &&
      pull.head.sha === headSha &&
      pull.head.repo?.full_name === headRepo &&
      pull.base.repo.full_name === repository,
  );
  if (matches.length !== 1) throw new Error(`expected one open PR for ${headRepo}@${headSha}`);
  return matches[0]!;
}

async function resolve(): Promise<void> {
  const headSha = process.env.HEAD_SHA ?? "";
  const headRepo = process.env.HEAD_REPO ?? "";
  const pull = await findExactPull(headSha, headRepo);
  const { repository } = tokenAndRepository();
  output("pr_number", String(pull.number));
  output("base_sha", pull.base.sha);
  output("head_sha", pull.head.sha);
  output("head_repo", headRepo);
  output("first_party", String(headRepo === repository));
  output("ci_green", String(process.env.CI_CONCLUSION === "success"));
}

function readJson(file: string): unknown {
  return JSON.parse(readPrivateRegularFile(file, { maxBytes: 1024 * 1024 })!);
}

export function advisorJobs(
  advisorDir: string,
  headSha: string,
  changedFiles: readonly string[],
): {
  jobs: string[];
  unsupported: string[];
} {
  const result = readJson(path.join(advisorDir, "e2e-target-advisor-result.json")) as TargetResult;
  const artifactPlan = readJson(path.join(advisorDir, "risk-plan.json")) as {
    headSha?: unknown;
    changedFiles?: unknown;
  };
  if (
    artifactPlan.headSha !== headSha ||
    !Array.isArray(artifactPlan.changedFiles) ||
    JSON.stringify([...artifactPlan.changedFiles].sort()) !==
      JSON.stringify([...changedFiles].sort()) ||
    result.version !== 1 ||
    !Array.isArray(result.changedFiles) ||
    JSON.stringify([...result.changedFiles].sort()) !== JSON.stringify([...changedFiles].sort()) ||
    !Array.isArray(result.required)
  ) {
    throw new Error("Advisor result does not match the exact-head risk plan");
  }
  const jobs: string[] = [];
  const unsupported: string[] = [];
  for (const recommendation of result.required) {
    if (!recommendation.required || typeof recommendation.id !== "string") continue;
    if (recommendation.selectorType === "job" && JOB.test(recommendation.id))
      jobs.push(recommendation.id);
    else unsupported.push(recommendation.id);
  }
  return { jobs: [...new Set(jobs)], unsupported: [...new Set(unsupported)] };
}

async function start(args: Record<string, string | undefined>): Promise<void> {
  const { token, repository } = tokenAndRepository();
  const prNumber = positive(args.pr, "pr");
  const baseSha = required(args.base, "base");
  const headSha = required(args.head, "head");
  const headRepo = required(args.headRepo, "head-repo");
  if (!SHA.test(baseSha) || !SHA.test(headSha) || !REPOSITORY.test(headRepo))
    throw new Error("invalid PR identity");

  const checkRunId = await createCheck(
    repository,
    token,
    headSha,
    "Required live E2E is being planned",
    `PR #${prNumber} at ${headSha.slice(0, 12)}.`,
    CHECK_NAME,
  );
  output("check_id", String(checkRunId));

  const pull = await githubApi<Pull>(`repos/${repository}/pulls/${prNumber}`, token);
  if (
    pull.state !== "open" ||
    pull.base.sha !== baseSha ||
    pull.head.sha !== headSha ||
    pull.head.repo?.full_name !== headRepo
  ) {
    await completeCheck({ repository, checkRunId }, token, {
      conclusion: "neutral",
      title: "PR head was superseded",
      summary: "No live E2E was dispatched for a stale PR revision.",
    });
    output("dispatched", "false");
    return;
  }
  if (args.ciGreen !== "true") {
    await completeCheck({ repository, checkRunId }, token, {
      conclusion: "failure",
      title: "Normal CI must pass before live E2E",
      summary:
        "The exact-head CI run did not complete successfully, so no live jobs were dispatched.",
    });
    output("dispatched", "false");
    return;
  }
  if (headRepo !== repository) {
    await completeCheck({ repository, checkRunId }, token, {
      conclusion: "neutral",
      title: "Fork live E2E requires maintainer approval",
      summary:
        "Advisor planning is automatic, but secret-bearing execution of fork code remains approval-gated.",
    });
    output("dispatched", "false");
    return;
  }

  const allowedJobs = new Set(readFreeStandingJobsInventory().allowedJobs);
  const changedFiles = changedFilesBetween(baseSha, headSha, process.cwd(), false);
  const plan = validateRiskPlan(buildRiskPlan({ headSha, changedFiles }), allowedJobs);
  const advisorDir = required(args.advisorDir, "advisor-dir");
  const fromAdvisor = advisorJobs(advisorDir, headSha, plan.changedFiles);
  const jobs = [...new Set([...plan.automaticJobs, ...fromAdvisor.jobs])];
  const invalidJobs = jobs.filter((job) => !allowedJobs.has(job));
  if (
    fromAdvisor.unsupported.length > 0 ||
    invalidJobs.length > 0 ||
    jobs.length > 3 ||
    plan.requiresManualExpansion
  ) {
    await completeCheck({ repository, checkRunId }, token, {
      conclusion: "neutral",
      title: "Required live plan needs maintainer expansion",
      summary: `Automatic jobs: ${jobs.join(", ") || "none"}. Unsupported selectors: ${fromAdvisor.unsupported.join(", ") || "none"}.`,
    });
    output("dispatched", "false");
    return;
  }
  if (jobs.length === 0) {
    await completeCheck({ repository, checkRunId }, token, {
      conclusion: "success",
      title: "No live E2E required",
      summary: "The exact-head deterministic and Advisor plans selected no required live jobs.",
    });
    output("dispatched", "false");
    return;
  }

  const correlationId = randomUUID();
  const executionPlanHash = createHash("sha256")
    .update(JSON.stringify({ deterministicPlanHash: plan.planHash, jobs: [...jobs].sort() }))
    .digest("hex");
  const runId = await dispatchRiskWorkflow({
    repository,
    token,
    jobs,
    commitSha: headSha,
    planHash: executionPlanHash,
    correlationId,
    prNumber,
  });
  const state: RiskGateState = {
    version: 1,
    commitSha: headSha,
    planHash: executionPlanHash,
    correlationId,
    expectedJobs: jobs,
    expectedShards: expectedRiskSignalShards(jobs),
    requiresManualExpansion: false,
    prNumber,
  };
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  const statePath = path.join(process.env.RUNNER_TEMP ?? "", "required-live-state.json");
  writePrivateRegularFile(statePath, serialized);
  output("state_hash", createHash("sha256").update(serialized).digest("hex"));
  output("run_id", String(runId));
  output("dispatched", "true");
}

async function cancel(args: Record<string, string | undefined>): Promise<void> {
  const { token, repository } = tokenAndRepository();
  const prNumber = positive(args.pr, "pr");
  const prefix = `E2E PR #${prNumber} risk `;
  for (const status of ["queued", "in_progress"]) {
    const runs = await githubRestPaginated<WorkflowRun>(
      `repos/${repository}/actions/workflows/e2e.yaml/runs?event=workflow_dispatch&status=${status}`,
      token,
      100,
    );
    for (const run of runs.filter((candidate) => candidate.display_title.startsWith(prefix))) {
      await githubApi(`repos/${repository}/actions/runs/${run.id}/cancel`, token, {
        method: "POST",
      });
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "resolve") return resolve();
  if (args.mode === "cancel") return cancel(args);
  if (args.mode === "start") return start(args);
  if (args.mode === "abandon") {
    const { token, repository } = tokenAndRepository();
    return completeCheck({ repository, checkRunId: positive(args.checkId, "check-id") }, token, {
      conclusion: "neutral",
      title: "Required live E2E coordinator stopped early",
      summary: "The coordinator could not produce complete exact-head evidence.",
    });
  }
  if (args.mode === "finish") {
    return finishRiskGate({
      statePath: required(args.state, "state"),
      stateHash: required(args.stateHash, "state-hash"),
      evidencePath: required(args.evidence, "evidence"),
      checkRunId: positive(args.checkId, "check-id"),
      childRunId: positive(args.runId, "run-id"),
    });
  }
  throw new Error("--mode must be resolve, cancel, start, finish, or abandon");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
