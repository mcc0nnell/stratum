import type { EvalPolicy } from "../evaluation/types";
import { recordAudit } from "../storage/audit";
import { countApprovals } from "../storage/change-reviews";
import { type EvalRun, listEvalRuns } from "../storage/eval-runs";
import type { Change } from "../types";
import type { Logger } from "../utils/logger";

export const FCR_STRATUM_MERGE_OBSERVATION_SCHEMA = "fcr.stratum.merge-observation.v1" as const;

export type FcrWitnessStatus = "satisfied" | "contradicted" | "unproven";

export interface FcrMergeWitness {
  id: string;
  kind: "evaluator" | "approval";
  required: boolean;
  status: FcrWitnessStatus;
  reason: string;
  score?: number;
  ranAt?: string;
  requiredCount?: number;
  observedCount?: number;
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
    evaluatorRunsAvailable: boolean;
    approvalsAvailable: boolean;
    witnesses: FcrMergeWitness[];
  };
  advisoryJudgment: {
    outcome: "would_admit_to_next_gate" | "would_veto";
    reasons: string[];
  };
}

export interface FcrProtectionVerdict {
  allowed: boolean;
  reasons: string[];
}

function latestRunsByEvaluator(runs: EvalRun[]): Map<string, EvalRun> {
  const latest = new Map<string, EvalRun>();
  for (const run of runs) {
    const current = latest.get(run.evaluatorType);
    if (
      !current ||
      run.ranAt > current.ranAt ||
      (run.ranAt === current.ranAt && run.id > current.id)
    ) {
      latest.set(run.evaluatorType, run);
    }
  }
  return latest;
}

export function buildFcrMergeObservation(args: {
  change: Change;
  policy: EvalPolicy;
  protection: FcrProtectionVerdict;
  evalRuns: EvalRun[];
  evaluatorRunsAvailable: boolean;
  approvalCount?: number;
  approvalsAvailable: boolean;
}): FcrMergeObservation {
  const { change, policy, protection } = args;
  const requiredEvaluators = [...(policy.merge?.requiredEvaluators ?? [])].sort();
  const requiredEvaluatorSet = new Set(requiredEvaluators);
  const latestRuns = latestRunsByEvaluator(args.evalRuns);
  const witnesses: FcrMergeWitness[] = [];

  for (const evaluatorType of [...latestRuns.keys()].sort()) {
    const run = latestRuns.get(evaluatorType);
    if (!run) continue;
    witnesses.push({
      id: `evaluator:${evaluatorType}`,
      kind: "evaluator",
      required: requiredEvaluatorSet.has(evaluatorType),
      status: run.passed ? "satisfied" : "contradicted",
      reason: run.reason,
      score: run.score,
      ranAt: run.ranAt,
    });
  }

  for (const evaluatorType of requiredEvaluators) {
    if (latestRuns.has(evaluatorType)) continue;
    witnesses.push({
      id: `evaluator:${evaluatorType}`,
      kind: "evaluator",
      required: true,
      status: "unproven",
      reason: `Required evaluator '${evaluatorType}' has not run`,
    });
  }

  const requiredApprovals = policy.merge?.requiredApprovals ?? 0;
  if (requiredApprovals > 0) {
    const observedCount = args.approvalCount;
    witnesses.push({
      id: "approval:human",
      kind: "approval",
      required: true,
      status:
        observedCount === undefined
          ? "unproven"
          : observedCount >= requiredApprovals
            ? "satisfied"
            : "contradicted",
      reason:
        observedCount === undefined
          ? `Required approval count could not be observed (requires ${requiredApprovals})`
          : `Requires ${requiredApprovals} approval${requiredApprovals === 1 ? "" : "s"}, has ${observedCount}`,
      requiredCount: requiredApprovals,
      ...(observedCount !== undefined ? { observedCount } : {}),
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
      requiredEvaluators,
      requiredApprovals,
      requireFreshBase: policy.merge?.requireFreshBase === true,
      allowForce: policy.merge?.allowForce === true,
      ...(policy.configError !== undefined ? { configError: policy.configError } : {}),
    },
    evidence: {
      evaluatorRunsAvailable: args.evaluatorRunsAvailable,
      approvalsAvailable: args.approvalsAvailable,
      witnesses,
    },
    advisoryJudgment: {
      outcome: protection.allowed ? "would_admit_to_next_gate" : "would_veto",
      reasons: [...protection.reasons].sort(),
    },
  };
}

/**
 * Emit an OBSERVE-only FCR envelope for Stratum's existing merge-protection decision.
 * Evidence collection is deliberately best-effort: it must never block, authorize,
 * or otherwise change the merge decision it describes.
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
    const requiredApprovals = args.policy.merge?.requiredApprovals ?? 0;
    const [evalRunsResult, approvalsResult] = await Promise.all([
      listEvalRuns(db, logger, args.change.id),
      requiredApprovals > 0 ? countApprovals(db, logger, args.change.id) : Promise.resolve(null),
    ]);

    const evaluatorRunsAvailable = evalRunsResult.success;
    if (!evalRunsResult.success) {
      logger.warn("FCR observer could not load evaluator runs", { changeId: args.change.id });
    }

    const approvalsAvailable = approvalsResult === null || approvalsResult.success;
    if (approvalsResult !== null && !approvalsResult.success) {
      logger.warn("FCR observer could not load approval count", { changeId: args.change.id });
    }

    const observation = buildFcrMergeObservation({
      ...args,
      evalRuns: evalRunsResult.success ? evalRunsResult.data : [],
      evaluatorRunsAvailable,
      ...(approvalsResult !== null && approvalsResult.success
        ? { approvalCount: approvalsResult.data }
        : {}),
      approvalsAvailable,
    });

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
