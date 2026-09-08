import type { EvalPolicy } from "../evaluation/types";
import { recordAudit } from "../storage/audit";
import type { Change } from "../types";
import type { Logger } from "../utils/logger";

export const FCR_STRATUM_MERGE_OBSERVATION_SCHEMA = "fcr.stratum.merge-observation.v1" as const;

export type FcrWitnessStatus = "satisfied" | "contradicted" | "unproven";

export interface FcrMergeWitness {
  id: string;
  kind: "evaluator" | "approval";
  required: true;
  status: FcrWitnessStatus;
  reason: string;
  score?: number;
  ranAt?: string;
  requiredCount?: number;
  observedCount?: number;
}

export interface FcrProtectionVerdict {
  allowed: boolean;
  reasons: string[];
  evidence: {
    requiredEvaluators: Array<{
      evaluatorType: string;
      status: "passed" | "failed" | "missing";
      reason: string;
      score?: number;
      ranAt?: string;
    }>;
    approvals?: {
      required: number;
      observed: number;
    };
  };
}

export interface FcrMergeObservation {
  schema: typeof FCR_STRATUM_MERGE_OBSERVATION_SCHEMA;
  stage: "merge_protection";
  authority: {
    mode: "observe";
    commitPermitIssued: false;
  };
  candidate: {
    kind: "stratum.change.merge";
    changeId: string;
    projectId: string;
    project: string;
    workspace: string;
    status: Change["status"];
    baseSha?: string;
    evaluatedSha?: string;
    evaluatedTreeOid?: string;
    workspaceHeadSha?: string;
  };
  policy: {
    configuredEvaluators: string[];
    requiredEvaluators: string[];
    requiredApprovals: number;
    requireFreshBase: boolean;
    allowForce: boolean;
    configError?: string;
  };
  evidence: {
    snapshotSource: "merge_protection_verdict";
    witnesses: FcrMergeWitness[];
  };
  advisoryJudgment: {
    outcome: "would_admit_to_next_gate" | "would_veto";
    reasons: string[];
  };
}

export function buildFcrMergeObservation(args: {
  change: Change;
  policy: EvalPolicy;
  protection: FcrProtectionVerdict;
}): FcrMergeObservation {
  const { change, policy, protection } = args;
  const witnesses: FcrMergeWitness[] = protection.evidence.requiredEvaluators.map((evidence) => ({
    id: `evaluator:${evidence.evaluatorType}`,
    kind: "evaluator",
    required: true,
    status:
      evidence.status === "passed"
        ? "satisfied"
        : evidence.status === "failed"
          ? "contradicted"
          : "unproven",
    reason: evidence.reason,
    ...(evidence.score !== undefined ? { score: evidence.score } : {}),
    ...(evidence.ranAt !== undefined ? { ranAt: evidence.ranAt } : {}),
  }));

  const approvalEvidence = protection.evidence.approvals;
  if (approvalEvidence !== undefined) {
    witnesses.push({
      id: "approval:human",
      kind: "approval",
      required: true,
      status:
        approvalEvidence.observed >= approvalEvidence.required ? "satisfied" : "contradicted",
      reason: `Requires ${approvalEvidence.required} approval${approvalEvidence.required === 1 ? "" : "s"}, has ${approvalEvidence.observed}`,
      requiredCount: approvalEvidence.required,
      observedCount: approvalEvidence.observed,
    });
  }
  witnesses.sort((a, b) => a.id.localeCompare(b.id));

  return {
    schema: FCR_STRATUM_MERGE_OBSERVATION_SCHEMA,
    stage: "merge_protection",
    authority: {
      mode: "observe",
      commitPermitIssued: false,
    },
    candidate: {
      kind: "stratum.change.merge",
      changeId: change.id,
      projectId: change.projectId ?? change.project,
      project: change.project,
      workspace: change.workspace,
      status: change.status,
      ...(change.baseSha !== undefined ? { baseSha: change.baseSha } : {}),
      ...(change.evaluatedSha !== undefined ? { evaluatedSha: change.evaluatedSha } : {}),
      ...(change.evaluatedTreeOid !== undefined
        ? { evaluatedTreeOid: change.evaluatedTreeOid }
        : {}),
      ...(change.workspaceHeadSha !== undefined
        ? { workspaceHeadSha: change.workspaceHeadSha }
        : {}),
    },
    policy: {
      configuredEvaluators: policy.evaluators.map((evaluator) => evaluator.type).sort(),
      requiredEvaluators: [...(policy.merge?.requiredEvaluators ?? [])].sort(),
      requiredApprovals: policy.merge?.requiredApprovals ?? 0,
      requireFreshBase: policy.merge?.requireFreshBase === true,
      allowForce: policy.merge?.allowForce === true,
      ...(policy.configError !== undefined ? { configError: policy.configError } : {}),
    },
    evidence: {
      snapshotSource: "merge_protection_verdict",
      witnesses,
    },
    advisoryJudgment: {
      outcome: protection.allowed ? "would_admit_to_next_gate" : "would_veto",
      reasons: [...protection.reasons].sort(),
    },
  };
}

/**
 * Persist an OBSERVE-only projection of the verdict Stratum already produced.
 * The envelope contains only evidence captured by that verdict; it never re-reads
 * mutable evaluator or approval state after the decision.
 */
export async function observeStratumMergeProtection(
  db: D1Database,
  logger: Logger,
  args: {
    change: Change;
    policy: EvalPolicy;
    protection: FcrProtectionVerdict;
  },
): Promise<void> {
  try {
    const observation = buildFcrMergeObservation(args);
    await recordAudit(db, logger, {
      action: "fcr.merge.observed",
      actorType: "system",
      subject: args.change.id,
      detail: { fcr: observation },
    });
  } catch (error) {
    logger.warn("FCR merge observation failed; merge behavior is unchanged", {
      changeId: args.change.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
