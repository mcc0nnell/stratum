import { describe, expect, it } from "vitest";
import type { EvalPolicy } from "../src/evaluation/types";
import { buildFcrMergeObservation } from "../src/fcr/merge-observation";
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

describe("buildFcrMergeObservation", () => {
  it("projects the exact protection snapshot into an OBSERVE-only FCR envelope", () => {
    const policy: EvalPolicy = {
      evaluators: [
        { type: "webhook", url: "https://ci.example.test/evaluate" },
        { type: "diff" },
      ],
      merge: {
        requiredEvaluators: ["secret_scan", "diff"],
        requiredApprovals: 2,
        requireFreshBase: true,
      },
    };

    const observation = buildFcrMergeObservation({
      change,
      policy,
      protection: {
        allowed: false,
        reasons: ["Required evaluator 'secret_scan' has not run", "Requires 2 approvals, has 1"],
        evidence: {
          requiredEvaluators: [
            {
              evaluatorType: "secret_scan",
              status: "missing",
            },
            {
              evaluatorType: "diff",
              status: "passed",
              runId: "evl_diff_latest",
              ranAt: "2026-09-08T12:00:00.000Z",
            },
          ],
          approvals: { required: 2, observed: 1 },
        },
      },
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
      touchesProtectedConfig: false,
    });
    expect(observation.policy.configuredEvaluators).toEqual(["diff", "webhook"]);
    expect(observation.policy.requiredEvaluators).toEqual(["diff", "secret_scan"]);
    expect(observation.policy.effectiveRequiredApprovals).toBe(2);
    expect(observation.evidence.snapshotSource).toBe("merge_protection_verdict");
    expect(
      observation.evidence.witnesses.map((witness) => [
        witness.id,
        witness.kind,
        witness.status,
        witness.evaluatorType,
      ]),
    ).toEqual([
      ["approval:human", "approval", "contradicted", undefined],
      ["evaluator:diff:1", "evaluator", "satisfied", "diff"],
      ["evaluator:secret_scan:0", "evaluator", "unproven", "secret_scan"],
    ]);
    expect(observation.evidence.witnesses[1]).toMatchObject({
      sourceRef: "evl_diff_latest",
      observedAt: "2026-09-08T12:00:00.000Z",
    });
    expect(observation.advisoryJudgment.outcome).toBe("would_veto");
  });

  it("preserves Stratum's implicit protected-config approval as effective policy", () => {
    const protectedChange: Change = {
      ...change,
      id: "chg_policy",
      touchesProtectedConfig: true,
    };
    const policy: EvalPolicy = { evaluators: [{ type: "diff" }] };

    const observation = buildFcrMergeObservation({
      change: protectedChange,
      policy,
      protection: {
        allowed: false,
        reasons: ["Requires 1 approval, has 0"],
        evidence: {
          requiredEvaluators: [],
          approvals: { required: 1, observed: 0 },
        },
      },
    });

    expect(observation.candidate.touchesProtectedConfig).toBe(true);
    expect(observation.policy.requiredApprovals).toBe(0);
    expect(observation.policy.effectiveRequiredApprovals).toBe(1);
    expect(observation.evidence.witnesses).toEqual([
      {
        id: "approval:human",
        kind: "approval",
        required: true,
        status: "contradicted",
        reason: "Requires 1 approval, has 0",
        requiredCount: 1,
        observedCount: 0,
      },
    ]);
    expect(observation.authority.commitPermitIssued).toBe(false);
  });
});
