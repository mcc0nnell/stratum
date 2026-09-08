import type { EvalPolicy } from "../evaluation/types";
import { observeStratumMergeProtection } from "../fcr/merge-observation";
import { countApprovals } from "../storage/change-reviews";
import { listEvalRuns } from "../storage/eval-runs";
import type { Change } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

export interface ProtectionVerdict {
  allowed: boolean;
  /** Human-readable reasons the merge is blocked. Empty when allowed. */
  reasons: string[];
  /** Exact evidence snapshot used to produce this verdict. */
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
  const observeVerdict = async (
    verdict: ProtectionVerdict,
  ): Promise<Result<ProtectionVerdict, AppError>> => {
    await observeStratumMergeProtection(db, logger, { change, policy, protection: verdict });
    return ok(verdict);
  };
  const evidence: ProtectionVerdict["evidence"] = { requiredEvaluators: [] };

  // Fail closed on a malformed policy file rather than silently running on the
  // permissive default.
  if (policy.configError) {
    return observeVerdict({ allowed: false, reasons: [policy.configError], evidence });
  }

  const merge = policy.merge;
  if (!merge) return observeVerdict({ allowed: true, reasons: [], evidence });

  const reasons: string[] = [];

  if (merge.requiredEvaluators && merge.requiredEvaluators.length > 0) {
    const runsResult = await listEvalRuns(db, logger, change.id);
    if (!runsResult.success) {
      return err(
        runsResult.error instanceof AppError
          ? runsResult.error
          : new AppError(runsResult.error.message, "DATABASE_ERROR", 500),
      );
    }

    const latestByType = new Map<
      string,
      { passed: boolean; ranAt: string; reason: string; score: number }
    >();
    for (const run of runsResult.data) {
      const current = latestByType.get(run.evaluatorType);
      if (!current || run.ranAt >= current.ranAt) {
        latestByType.set(run.evaluatorType, {
          passed: run.passed,
          ranAt: run.ranAt,
          reason: run.reason,
          score: run.score,
        });
      }
    }

    for (const required of merge.requiredEvaluators) {
      const latest = latestByType.get(required);
      if (!latest) {
        const reason = `Required evaluator '${required}' has not run`;
        reasons.push(reason);
        evidence.requiredEvaluators.push({
          evaluatorType: required,
          status: "missing",
          reason,
        });
      } else {
        evidence.requiredEvaluators.push({
          evaluatorType: required,
          status: latest.passed ? "passed" : "failed",
          reason: latest.reason,
          score: latest.score,
          ranAt: latest.ranAt,
        });
        if (!latest.passed) {
          reasons.push(`Required evaluator '${required}' failed`);
        }
      }
    }
  }

  const requiredApprovals = merge.requiredApprovals ?? 0;
  if (requiredApprovals > 0) {
    // NOTE: self-approval exclusion (countApprovals' excludeUserId arg) is wired in a
    // follow-up — the `changes` table records no creating-user id yet (only agentId),
    // so excluding the author requires a schema addition. Tracked in TASKS.md.
    const approvalsResult = await countApprovals(db, logger, change.id);
    if (!approvalsResult.success) return err(approvalsResult.error);
    evidence.approvals = { required: requiredApprovals, observed: approvalsResult.data };
    if (approvalsResult.data < requiredApprovals) {
      reasons.push(
        `Requires ${requiredApprovals} approval${requiredApprovals === 1 ? "" : "s"}, has ${approvalsResult.data}`,
      );
    }
  }

  if (reasons.length > 0) {
    logger.info("Merge blocked by branch protection", { changeId: change.id, reasons });
  }
  return observeVerdict({ allowed: reasons.length === 0, reasons, evidence });
}
