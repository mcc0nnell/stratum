import type { EvalPolicy } from "../evaluation/types";
import type { Change } from "../types";
import type { Logger } from "../utils/logger";
import {
  currentFcrStratumDeploymentIdentity,
  type FcrStratumDeploymentIdentity,
} from "./deployment-identity";

export const FCR_STRATUM_MERGE_OBSERVATION_SCHEMA = "fcr.stratum.merge-observation.v1" as const;
export const FCR_STRATUM_MERGE_HANDOFF_SCHEMA = "fcr.stratum.merge-handoff.v1" as const;

export type FcrWitnessStatus = "satisfied" | "contradicted" | "unproven";

export interface FcrMergeWitness {
  id: string;
  kind: "evaluator" | "approval";
  required: true;
  status: FcrWitnessStatus;
  reason: string;
  evaluatorType?: string;
  sourceRef?: string;
  observedAt?: string;
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
      runId?: string;
      ranAt?: string;
    }>;
    approvals?: {
      required: number;
      observed: number;
    };
  };
}

export interface FcrMergePremiseSnapshot {
  source: "stratum.d1.merge-protection-snapshot";
  evalRunsRead: boolean;
  reviewsRead: boolean;
  excludedReviewerId?: string;
  evalRuns: Array<{
    id: string;
    changeId: string;
    evaluatorType: string;
    passed: boolean;
    ranAt: string;
  }>;
  reviews: Array<{
    id: string;
    changeId: string;
    reviewerId: string;
    verdict: "approve" | "request_changes" | "comment";
    createdAt: string;
  }>;
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
    touchesProtectedConfig: boolean;
    createdByUserId?: string;
    baseSha?: string;
    evaluatedSha?: string;
    evaluatedTreeOid?: string;
    workspaceHeadSha?: string;
  };
  policy: {
    configuredEvaluators: string[];
    requiredEvaluators: string[];
    requiredApprovals: number;
    effectiveRequiredApprovals: number;
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

export interface FcrMergeHandoff {
  schema: typeof FCR_STRATUM_MERGE_HANDOFF_SCHEMA;
  authority: {
    mode: "observe";
    commitPermitIssued: false;
  };
  producerDeployment?: FcrStratumDeploymentIdentity;
  observation: FcrMergeObservation;
  premises: FcrMergePremiseSnapshot;
}

function evaluatorReason(evaluatorType: string, status: "passed" | "failed" | "missing"): string {
  if (status === "missing") return `Required evaluator '${evaluatorType}' has not run`;
  return `Required evaluator '${evaluatorType}' ${status}`;
}

export function buildFcrMergeObservation(args: {
  change: Change;
  policy: EvalPolicy;
  protection: FcrProtectionVerdict;
}): FcrMergeObservation {
  const { change, policy, protection } = args;
  const witnesses: FcrMergeWitness[] = protection.evidence.requiredEvaluators.map(
    (evidence, index) => ({
      id: `evaluator:${evidence.evaluatorType}:${index}`,
      kind: "evaluator",
      required: true,
      status:
        evidence.status === "passed"
          ? "satisfied"
          : evidence.status === "failed"
            ? "contradicted"
            : "unproven",
      reason: evaluatorReason(evidence.evaluatorType, evidence.status),
      evaluatorType: evidence.evaluatorType,
      ...(evidence.runId !== undefined ? { sourceRef: evidence.runId } : {}),
      ...(evidence.ranAt !== undefined ? { observedAt: evidence.ranAt } : {}),
    }),
  );

  const approvalEvidence = protection.evidence.approvals;
  if (approvalEvidence !== undefined) {
    const approvalNoun = approvalEvidence.required === 1 ? "approval" : "approvals";
    witnesses.push({
      id: "approval:human",
      kind: "approval",
      required: true,
      status:
        approvalEvidence.observed >= approvalEvidence.required ? "satisfied" : "contradicted",
      reason: `Requires ${approvalEvidence.required} ${approvalNoun}, has ${approvalEvidence.observed}`,
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
      touchesProtectedConfig: change.touchesProtectedConfig === true,
      ...(change.createdByUserId !== undefined ? { createdByUserId: change.createdByUserId } : {}),
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
      effectiveRequiredApprovals: approvalEvidence?.required ?? 0,
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

export function buildFcrMergeHandoff(args: {
  change: Change;
  policy: EvalPolicy;
  protection: FcrProtectionVerdict;
  premises: FcrMergePremiseSnapshot;
  producerDeployment?: FcrStratumDeploymentIdentity;
}): FcrMergeHandoff {
  return {
    schema: FCR_STRATUM_MERGE_HANDOFF_SCHEMA,
    authority: { mode: "observe", commitPermitIssued: false },
    ...(args.producerDeployment !== undefined
      ? { producerDeployment: { ...args.producerDeployment } }
      : {}),
    observation: buildFcrMergeObservation(args),
    premises: {
      source: "stratum.d1.merge-protection-snapshot",
      evalRunsRead: args.premises.evalRunsRead,
      reviewsRead: args.premises.reviewsRead,
      ...(args.premises.excludedReviewerId !== undefined
        ? { excludedReviewerId: args.premises.excludedReviewerId }
        : {}),
      evalRuns: args.premises.evalRuns.map((run) => ({ ...run })),
      reviews: args.premises.reviews.map((review) => ({ ...review })),
    },
  };
}

/**
 * Emit the OBSERVE-only reasoning projection and the raw decision-premise handoff.
 * No new persistence or external I/O is introduced; both objects ride the
 * existing structured logger and cannot alter the merge verdict.
 */
export function observeStratumMergeProtection(
  logger: Logger,
  args: {
    change: Change;
    policy: EvalPolicy;
    protection: FcrProtectionVerdict;
    premises: FcrMergePremiseSnapshot;
  },
): void {
  try {
    const fcr = buildFcrMergeObservation(args);
    const producerDeployment = currentFcrStratumDeploymentIdentity();
    const fcrHandoff = buildFcrMergeHandoff({
      ...args,
      ...(producerDeployment !== undefined ? { producerDeployment } : {}),
    });
    logger.info("FCR merge protection observed", { fcr, fcrHandoff });
  } catch (error) {
    logger.warn("FCR merge observation failed; merge behavior is unchanged", {
      changeId: args.change.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
