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

function makeD1(opts: { runs?: EvalRunRow[]; approvals?: number }): D1Database {
  function makeStmt(sql: string, bindings: unknown[]) {
    const upper = sql.trim().toUpperCase();
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      first: async <T>() => {
        if (upper.includes("COUNT(*)")) return { approvals: opts.approvals ?? 0 } as T;
        return null;
      },
      all: async <T>() => {
        const results = (opts.runs ?? []).filter((run) => run.change_id === bindings[0]);
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
  it("binds FCR evidence to the exact evaluator and approval snapshot used by the verdict", async () => {
    vi.mocked(observeStratumMergeProtection).mockClear();
    const db = makeD1({
      approvals: 1,
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
              reason: "latest pass",
              score: 0.92,
              ranAt: "2026-09-08T12:00:00.000Z",
            },
          ],
          approvals: { required: 2, observed: 1 },
        },
      },
    });
  });

  it("captures the implicit human gate for a change that edits protected configuration", async () => {
    vi.mocked(observeStratumMergeProtection).mockClear();
    const protectedChange: Change = { ...change, touchesProtectedConfig: true };
    const db = makeD1({ approvals: 0 });
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
    });
  });
});
