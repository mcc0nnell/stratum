import { describe, expect, it } from "vitest";
import {
  currentFcrStratumDeploymentIdentity,
  FCR_STRATUM_DEPLOYMENT_IDENTITY_SOURCE,
} from "../src/fcr/deployment-identity";
import { buildFcrMergeHandoff } from "../src/fcr/merge-observation";
import type { Change } from "../src/types";

const change: Change = {
  id: "chg_deployment_identity",
  project: "stratum",
  projectId: "prj_1",
  workspace: "agent-work",
  status: "accepted",
  createdAt: "2026-09-08T12:00:00.000Z",
};

const premises = {
  source: "stratum.d1.merge-protection-snapshot" as const,
  evalRunsRead: false,
  reviewsRead: false,
  evalRuns: [],
  reviews: [],
};

const protection = {
  allowed: true,
  reasons: [],
  evidence: { requiredEvaluators: [] },
};

describe("currentFcrStratumDeploymentIdentity", () => {
  it("returns undefined when version metadata is unavailable or malformed", () => {
    expect(currentFcrStratumDeploymentIdentity(undefined)).toBeUndefined();
    expect(currentFcrStratumDeploymentIdentity("not-json")).toBeUndefined();
    expect(currentFcrStratumDeploymentIdentity(JSON.stringify({ id: "version-only" }))).toBeUndefined();
  });

  it("binds the Worker version identity without inventing a source commit", () => {
    expect(
      currentFcrStratumDeploymentIdentity(
        JSON.stringify({
          id: "0d9f9adf-377f-4b87-a1f8-a8e745de1b52",
          tag: "staging-canary",
          timestamp: "2026-09-08T14:00:00.000Z",
        }),
      ),
    ).toEqual({
      source: FCR_STRATUM_DEPLOYMENT_IDENTITY_SOURCE,
      workerVersionId: "0d9f9adf-377f-4b87-a1f8-a8e745de1b52",
      workerVersionTimestamp: "2026-09-08T14:00:00.000Z",
      workerVersionTag: "staging-canary",
    });
  });

  it("treats a canonical Git-shaped version tag only as a source-commit claim", () => {
    const sha = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
    expect(
      currentFcrStratumDeploymentIdentity(
        JSON.stringify({
          id: "4ee63972-5639-4142-81a1-7f0d8165934a",
          tag: sha,
          timestamp: "2026-09-08T14:05:00.000Z",
        }),
      ),
    ).toEqual({
      source: FCR_STRATUM_DEPLOYMENT_IDENTITY_SOURCE,
      workerVersionId: "4ee63972-5639-4142-81a1-7f0d8165934a",
      workerVersionTimestamp: "2026-09-08T14:05:00.000Z",
      workerVersionTag: sha,
      sourceCommitClaim: sha.toLowerCase(),
      sourceCommitClaimSource: "worker-version-tag",
    });
  });
});

describe("FCR merge handoff deployment identity", () => {
  it("carries deployment identity as provenance without changing observation authority", () => {
    const producerDeployment = currentFcrStratumDeploymentIdentity(
      JSON.stringify({
        id: "version-1",
        tag: "a".repeat(40),
        timestamp: "2026-09-08T14:10:00.000Z",
      }),
    );
    expect(producerDeployment).toBeDefined();

    const handoff = buildFcrMergeHandoff({
      change,
      policy: { evaluators: [] },
      protection,
      premises,
      producerDeployment,
    });

    expect(handoff.producerDeployment).toEqual(producerDeployment);
    expect(handoff.authority).toEqual({ mode: "observe", commitPermitIssued: false });
    expect(handoff.observation.authority).toEqual({ mode: "observe", commitPermitIssued: false });
  });

  it("remains backward-compatible when deployment metadata is unavailable", () => {
    const handoff = buildFcrMergeHandoff({
      change,
      policy: { evaluators: [] },
      protection,
      premises,
    });

    expect(handoff.producerDeployment).toBeUndefined();
  });
});
