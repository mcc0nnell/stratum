import { describe, expect, it, vi } from "vitest";
import type { EvalPolicy } from "../src/evaluation/types";
import { observeStratumMergeProtection } from "../src/fcr/merge-observation";
import { checkMergeProtection } from "../src/merge/protection";
import type { Change } from "../src/types";
import type { Logger } from "../src/utils/logger";

vi.mock("../src/fcr/merge-observation", () => ({
  observeStratumMergeProtection: vi.fn(() => undefined),
}));

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

interface EvalRunRow {
  id: string;
  change_id: string;
  evaluator_type: string;
  score: number;
  passed: number;
  reason: string;
  issues: string | null;
  ran_at: string;
}

interface ReviewRow {
  id: string;
  change_id: string;
  reviewer_id: string;
  verdict: "approve" | "request_changes" | "comment";
  comment: string | null;
  created_at: string;
}

function makeD1(opts: { runs?: EvalRunRow[]; reviews?: ReviewRow[] }): D1Database {
  function makeStmt(sql: string, bindings: unknown[]) {
    const upper = sql.trim().toUpperCase();
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      first: async <T>() => null as T | null,
      all: async <T>() => {
        const results = upper.includes("FROM CHANGE_REVIEWS")
          ? (opts.reviews ?? []).filter((review) => review.change_id === bindings[0])
          : (opts.runs ?? []).filter((run) => run.change_id === bindings[0]);
        return { results: results as T[], success: true, meta: {} };
      },
    };
  }
  return { prepare: (sql: string) => makeStmt(sql, []) } as unknown as D1Database;
}

const change: Change = {
  id: "chg_fcr_protection",
  project: "stratum",
  projectId: "prj_1",
  workspace: "agent-work",
  status: "accepted",
  createdByUserId: "usr_author",
  createdAt: "2026-09-08T12:00:00.000Z",
};

describe("FCR merge-protection observation", () => {
  it("binds FCR evidence to the exact evaluator and approval rows used by the verdict", async () => {
    vi.mocked(observeStratumMergeProtection).mockClear();
    const db = makeD1({
      reviews: [
        {
          id: "rev_author",
          change_id: change.id,
          reviewer_id: "usr_author",
          verdict: "approve",
          comment: "self approval does not count",
          created_at: "2026-09-08T11:40:00.000Z",
        },
        {
          id: "rev_human",
          change_id: change.id,
          reviewer_id: "usr_reviewer",
          verdict: "approve",
          comment: "looks good",
          created_at: "2026-09-08T11:45:00.000Z",
        },
      ],
      runs: [
        {
          id: "evl_old",
          change_id: change.id,
          evaluator_type: "diff",
          score: 0.1,
          passed: 0,
          reason: "old failure",
          issues: null,
          ran_at: "2026-09-08T11:00:00.000Z",
        },
        {
          id: "evl_new",
          change_id: change.id,
          evaluator_type: "diff",
          score: 0.92,
          passed: 1,
          reason: "latest pass",
          issues: null,
          ran_at: "2026-09-08T12:00:00.000Z",
        },
      ],
    });
    const policy: EvalPolicy = {
      evaluators: [{ type: "diff" }],
      merge: { requiredEvaluators: ["diff"], requiredApprovals: 2 },
    };

    const result = await checkMergeProtection(db, mockLogger, change, policy);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.allowed).toBe(false);
    expect(observeStratumMergeProtection).toHaveBeenCalledWith(mockLogger, {
      change,
      policy,
      protection: {
        allowed: false,
        reasons: ["Requires 2 approvals, has 1"],
        evidence: {
          requiredEvaluators: [
            {
              evaluatorType: "diff",
              status: "passed",
              runId: "evl_new",
              ranAt: "2026-09-08T12:00:00.000Z",
            },
          ],
          approvals: { required: 2, observed: 1 },
        },
      },
      premises: {
        source: "stratum.d1.merge-protection-snapshot",
        evalRunsRead: true,
        reviewsRead: true,
        excludedReviewerId: "usr_author",
        evalRuns: [
          {
            id: "evl_old",
            changeId: change.id,
            evaluatorType: "diff",
            passed: false,
            ranAt: "2026-09-08T11:00:00.000Z",
          },
          {
            id: "evl_new",
            changeId: change.id,
            evaluatorType: "diff",
            passed: true,
            ranAt: "2026-09-08T12:00:00.000Z",
          },
        ],
        reviews: [
          {
            id: "rev_author",
            changeId: change.id,
            reviewerId: "usr_author",
            verdict: "approve",
            createdAt: "2026-09-08T11:40:00.000Z",
          },
          {
            id: "rev_human",
            changeId: change.id,
            reviewerId: "usr_reviewer",
            verdict: "approve",
            createdAt: "2026-09-08T11:45:00.000Z",
          },
        ],
      },
    });
  });

  it("captures the implicit human gate with an explicit empty review snapshot", async () => {
    vi.mocked(observeStratumMergeProtection).mockClear();
    const protectedChange: Change = { ...change, touchesProtectedConfig: true };
    const db = makeD1({ reviews: [] });
    const policy: EvalPolicy = { evaluators: [{ type: "diff" }] };

    const result = await checkMergeProtection(db, mockLogger, protectedChange, policy);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.allowed).toBe(false);
    expect(observeStratumMergeProtection).toHaveBeenCalledWith(mockLogger, {
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
      premises: {
        source: "stratum.d1.merge-protection-snapshot",
        evalRunsRead: false,
        reviewsRead: true,
        excludedReviewerId: "usr_author",
        evalRuns: [],
        reviews: [],
      },
    });
  });
});
