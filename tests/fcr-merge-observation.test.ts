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
      evaluators: [{ type: "webhook", url: "https://ci.example.test/evaluate" }, { type: "diff" }],
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
              reason: "Required evaluator 'secret_scan' has not run",
            },
            {
              evaluatorType: "diff",
              status: "passed",
              reason: "diff acceptable",
              score: 0.92,
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
    });
    expect(observation.policy.configuredEvaluators).toEqual(["diff", "webhook"]);
    expect(observation.policy.requiredEvaluators).toEqual(["diff", "secret_scan"]);
    expect(observation.evidence.snapshotSource).toBe("merge_protection_verdict");
    expect(observation.evidence.witnesses.map((witness) => [witness.id, witness.status])).toEqual([
      ["approval:human", "contradicted"],
      ["evaluator:diff", "satisfied"],
      ["evaluator:secret_scan", "unproven"],
    ]);
    expect(observation.advisoryJudgment.outcome).toBe("would_veto");
  });

  it("preserves missing evidence as unproven without manufacturing authority", () => {
    const policy: EvalPolicy = {
      evaluators: [{ type: "diff" }],
      merge: { requiredEvaluators: ["diff"] },
    };

    const observation = buildFcrMergeObservation({
      change,
      policy,
      protection: {
        allowed: false,
        reasons: ["Required evaluator 'diff' has not run"],
        evidence: {
          requiredEvaluators: [
            {
              evaluatorType: "diff",
              status: "missing",
              reason: "Required evaluator 'diff' has not run",
            },
          ],
        },
      },
    });

    expect(observation.evidence.witnesses).toEqual([
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
