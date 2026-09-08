import { describe, expect, it } from "vitest";
import type { EvalPolicy } from "../src/evaluation/types";
import { buildFcrMergeObservation } from "../src/fcr/merge-observation";
import type { EvalRun } from "../src/storage/eval-runs";
import type { Change } from "../src/types";

const change: Change = {
  id: "chg_fcr_1",
  project: "stratum",
  projectId: "prj_1",
  workspace: "agent-work",
  status: "accepted",
  baseSha: "base_1",
  evaluatedSha: "commit_1",
  evaluatedTreeOid: "tree_1",
  workspaceHeadSha: "commit_1",
  createdAt: "2026-09-08T12:00:00.000Z",
};

function run(overrides: Partial<EvalRun>): EvalRun {
  return {
    id: "evl_1",
    changeId: change.id,
    evaluatorType: "diff",
    score: 1,
    passed: true,
    reason: "ok",
    ranAt: "2026-09-08T12:00:00.000Z",
    ...overrides,
  };
}

describe("buildFcrMergeObservation", () => {
  it("projects Stratum protection evidence into an OBSERVE-only FCR envelope", () => {
    const policy: EvalPolicy = {
      evaluators: [{ type: "webhook", url: "https://ci.example.test/evaluate" }, { type: "diff" }],
      merge: {
        requiredEvaluators: ["secret_scan", "diff"],
        requiredApprovals: 2,
        requireFreshBase: true,
      },
    };
    const evalRuns: EvalRun[] = [
      run({ id: "evl_old", passed: false, ranAt: "2026-09-08T11:00:00.000Z" }),
      run({ id: "evl_new", passed: true, ranAt: "2026-09-08T12:00:00.000Z" }),
      run({
        id: "evl_webhook",
        evaluatorType: "webhook",
        score: 0,
        passed: false,
        reason: "external evidence unavailable",
      }),
    ];

    const observation = buildFcrMergeObservation({
      change,
      policy,
      protection: {
        allowed: false,
        reasons: ["Required evaluator 'secret_scan' has not run", "Requires 2 approvals, has 1"],
      },
      evalRuns,
      evaluatorRunsAvailable: true,
      approvalCount: 1,
      approvalsAvailable: true,
    });

    expect(observation.schema).toBe("fcr.stratum.merge-observation.v1");
    expect(observation.authority).toEqual({ mode: "observe", commitPermitIssued: false });
    expect(observation.candidate).toMatchObject({
      kind: "stratum.change.merge",
      changeId: change.id,
      projectId: "prj_1",
      evaluatedSha: "commit_1",
      evaluatedTreeOid: "tree_1",
      workspaceHeadSha: "commit_1",
    });
    expect(observation.policy.configuredEvaluators).toEqual(["diff", "webhook"]);
    expect(observation.policy.requiredEvaluators).toEqual(["diff", "secret_scan"]);
    expect(observation.evidence.witnesses.map((witness) => [witness.id, witness.status])).toEqual([
      ["approval:human", "contradicted"],
      ["evaluator:diff", "satisfied"],
      ["evaluator:secret_scan", "unproven"],
      ["evaluator:webhook", "contradicted"],
    ]);
    expect(observation.advisoryJudgment.outcome).toBe("would_veto");
  });

  it("marks unavailable supporting evidence as unproven without manufacturing authority", () => {
    const policy: EvalPolicy = {
      evaluators: [{ type: "diff" }],
      merge: { requiredEvaluators: ["diff"], requiredApprovals: 1 },
    };

    const observation = buildFcrMergeObservation({
      change,
      policy,
      protection: { allowed: false, reasons: ["Required evaluator 'diff' has not run"] },
      evalRuns: [],
      evaluatorRunsAvailable: false,
      approvalsAvailable: false,
    });

    expect(observation.evidence.evaluatorRunsAvailable).toBe(false);
    expect(observation.evidence.approvalsAvailable).toBe(false);
    expect(observation.evidence.witnesses).toEqual([
      {
        id: "approval:human",
        kind: "approval",
        required: true,
        status: "unproven",
        reason: "Required approval count could not be observed (requires 1)",
        requiredCount: 1,
      },
      {
        id: "evaluator:diff",
        kind: "evaluator",
        required: true,
        status: "unproven",
        reason: "Required evaluator 'diff' has not run",
      },
    ]);
    expect(observation.authority.commitPermitIssued).toBe(false);
  });
});
