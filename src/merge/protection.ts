import { diffTouchesProtectedConfig } from "../evaluation/policy-loader";
import type { EvalPolicy } from "../evaluation/types";
import {
  type FcrMergePremiseSnapshot,
  observeStratumMergeProtection,
} from "../fcr/merge-observation";
import {
  approvalCountFromReviews,
  countApprovals,
  listReviews,
} from "../storage/change-reviews";
import { listEvalRuns } from "../storage/eval-runs";
import type { Change } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

export interface ProtectionVerdict {
  allowed: boolean;
  /** Human-readable reasons the merge is blocked. Empty when allowed. */
  reasons: string[];
}

interface ProtectionEvidenceSnapshot {
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
}

/**
 * Evaluate the policy's merge-protection rules against a change.
 *
 * Required evaluators check the LATEST run per evaluator type — an earlier
 * failed run that was superseded by a passing re-run does not block.
 */
export async function checkMergeProtection(
  db: D1Database,
  logger: Logger,
  change: Change,
  policy: EvalPolicy,
): Promise<Result<ProtectionVerdict, AppError>> {
  const premises: FcrMergePremiseSnapshot = {
    source: "stratum.d1.merge-protection-snapshot",
    evalRunsRead: false,
    reviewsRead: false,
    ...(change.createdByUserId !== undefined
      ? { excludedReviewerId: change.createdByUserId }
      : {}),
    evalRuns: [],
    reviews: [],
  };

  const observeVerdict = (
    verdict: ProtectionVerdict,
    evidence: ProtectionEvidenceSnapshot,
  ): Result<ProtectionVerdict, AppError> => {
    observeStratumMergeProtection(logger, {
      change,
      policy,
      protection: { ...verdict, evidence },
      premises,
    });
    return ok(verdict);
  };
  const evidence: ProtectionEvidenceSnapshot = { requiredEvaluators: [] };

  // Fail closed on a malformed policy file rather than silently running on the
  // permissive default.
  if (policy.configError) {
    return observeVerdict({ allowed: false, reasons: [policy.configError] }, evidence);
  }

  const merge = policy.merge;
  // A change that edits the merge-protection config is gated even when the policy
  // has no merge block at all (SA-3), so we can't early-return on a missing merge.
  if (!merge && !change.touchesProtectedConfig) {
    return observeVerdict({ allowed: true, reasons: [] }, evidence);
  }

  const reasons: string[] = [];

  if (merge?.requiredEvaluators && merge.requiredEvaluators.length > 0) {
    const runsResult = await listEvalRuns(db, logger, change.id);
    if (!runsResult.success) {
      return err(
        runsResult.error instanceof AppError
          ? runsResult.error
          : new AppError(runsResult.error.message, "DATABASE_ERROR", 500),
      );
    }

    premises.evalRunsRead = true;
    premises.evalRuns = runsResult.data.map((run) => ({
      id: run.id,
      changeId: run.changeId,
      evaluatorType: run.evaluatorType,
      passed: run.passed,
      ranAt: run.ranAt,
    }));

    const latestByType = new Map<string, { id: string; passed: boolean; ranAt: string }>();
    for (const run of runsResult.data) {
      const current = latestByType.get(run.evaluatorType);
      if (!current || run.ranAt >= current.ranAt) {
        latestByType.set(run.evaluatorType, {
          id: run.id,
          passed: run.passed,
          ranAt: run.ranAt,
        });
      }
    }

    for (const required of merge.requiredEvaluators) {
      const latest = latestByType.get(required);
      if (!latest) {
        reasons.push(`Required evaluator '${required}' has not run`);
        evidence.requiredEvaluators.push({
          evaluatorType: required,
          status: "missing",
        });
      } else {
        evidence.requiredEvaluators.push({
          evaluatorType: required,
          status: latest.passed ? "passed" : "failed",
          runId: latest.id,
          ranAt: latest.ranAt,
        });
        if (!latest.passed) {
          reasons.push(`Required evaluator '${required}' failed`);
        }
      }
    }
  }

  // A change that edits the merge-protection config must always carry at least
  // one human approval, even if the policy sets requiredApprovals: 0 — otherwise
  // a writer could relax protection (allowForce, drop evaluators, zero approvals)
  // in a change that merges with no human ever looking (SA-3).
  const requiredApprovals = Math.max(
    merge?.requiredApprovals ?? 0,
    change.touchesProtectedConfig ? 1 : 0,
  );
  if (requiredApprovals > 0) {
    // Read the exact current review rows and derive the count from that same
    // snapshot. This preserves the existing approval rule while making the
    // premises independently reopenable without a second, racy D1 read.
    const reviewsResult = await listReviews(db, logger, change.id);
    if (!reviewsResult.success) return err(reviewsResult.error);
    premises.reviewsRead = true;
    premises.reviews = reviewsResult.data.map((review) => ({
      id: review.id,
      changeId: review.changeId,
      reviewerId: review.reviewerId,
      verdict: review.verdict,
      createdAt: review.createdAt,
    }));

    const observedApprovals = approvalCountFromReviews(
      reviewsResult.data,
      change.createdByUserId,
    );
    evidence.approvals = { required: requiredApprovals, observed: observedApprovals };
    if (observedApprovals < requiredApprovals) {
      reasons.push(
        `Requires ${requiredApprovals} approval${requiredApprovals === 1 ? "" : "s"}, has ${observedApprovals}`,
      );
    }
  }

  if (reasons.length > 0) {
    logger.info("Merge blocked by branch protection", { changeId: change.id, reasons });
  }
  return observeVerdict({ allowed: reasons.length === 0, reasons }, evidence);
}

/**
 * Same reason strings `checkMergeProtection` produces for `requiredEvaluators`,
 * but sourced from an in-memory list of evaluation runs instead of a change's
 * persisted `eval_runs` history. Exported separately so it's independently
 * testable — see `checkResolutionMergeProtection` for why a manual conflict
 * resolution needs this instead of the DB-backed check.
 */
export function requiredEvaluatorReasons(
  evalRuns: Array<{ evaluatorType: string; result: { passed: boolean } }>,
  requiredEvaluators: string[] | undefined,
): string[] {
  if (!requiredEvaluators || requiredEvaluators.length === 0) return [];

  const passedByType = new Map<string, boolean>();
  for (const { evaluatorType, result } of evalRuns) {
    passedByType.set(evaluatorType, (passedByType.get(evaluatorType) ?? true) && result.passed);
  }

  const reasons: string[] = [];
  for (const required of requiredEvaluators) {
    const passed = passedByType.get(required);
    if (passed === undefined) {
      reasons.push(`Required evaluator '${required}' has not run`);
    } else if (!passed) {
      reasons.push(`Required evaluator '${required}' failed`);
    }
  }
  return reasons;
}

/**
 * Merge-protection check for a manual conflict resolution (issue #260,
 * SA-5 follow-up).
 *
 * This remains outside the FCR observation slice in this PR. Its semantics are
 * unchanged and continue to use the existing count query for originating-change
 * approvals.
 */
export async function checkResolutionMergeProtection(
  db: D1Database,
  logger: Logger,
  args: {
    diff: string;
    evalRuns: Array<{ evaluatorType: string; result: { passed: boolean } }>;
    originatingChange?: { id: string; createdByUserId?: string };
  },
  policy: EvalPolicy,
): Promise<Result<ProtectionVerdict, AppError>> {
  if (policy.configError) {
    return ok({ allowed: false, reasons: [policy.configError] });
  }

  const merge = policy.merge;
  const touchesProtectedConfig = diffTouchesProtectedConfig(args.diff);
  if (!merge && !touchesProtectedConfig) return ok({ allowed: true, reasons: [] });

  const reasons: string[] = requiredEvaluatorReasons(args.evalRuns, merge?.requiredEvaluators);

  const requiredApprovals = Math.max(merge?.requiredApprovals ?? 0, touchesProtectedConfig ? 1 : 0);
  if (requiredApprovals > 0) {
    if (!args.originatingChange) {
      reasons.push(
        `Requires ${requiredApprovals} approval${requiredApprovals === 1 ? "" : "s"}, but this resolution has no linked change to verify approvals against`,
      );
    } else {
      const approvalsResult = await countApprovals(
        db,
        logger,
        args.originatingChange.id,
        args.originatingChange.createdByUserId,
      );
      if (!approvalsResult.success) return err(approvalsResult.error);
      if (approvalsResult.data < requiredApprovals) {
        reasons.push(
          `Requires ${requiredApprovals} approval${requiredApprovals === 1 ? "" : "s"}, has ${approvalsResult.data}`,
        );
      }
    }
  }

  if (reasons.length > 0) {
    logger.info("Manual conflict resolution blocked by branch protection", { reasons });
  }
  return ok({ allowed: reasons.length === 0, reasons });
}
