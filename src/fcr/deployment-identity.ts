const GIT_SHA_40 = /^[a-f0-9]{40}$/;

export const FCR_STRATUM_DEPLOYMENT_IDENTITY_SOURCE =
  "cloudflare.worker.version-metadata" as const;

export interface FcrStratumDeploymentIdentity {
  source: typeof FCR_STRATUM_DEPLOYMENT_IDENTITY_SOURCE;
  workerVersionId: string;
  workerVersionTimestamp: string;
  workerVersionTag?: string;
  sourceCommitClaim?: string;
  sourceCommitClaimSource?: "worker-version-tag";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read Cloudflare's version-metadata binding from process.env.
 *
 * With nodejs_compat and a compatibility date after 2025-04-01, Workers exposes
 * version metadata through process.env as JSON. A 40-hex version tag is treated
 * only as a source-commit claim bound to this Worker version; the tag does not by
 * itself prove that the deployed bytes came from that Git object.
 */
export function currentFcrStratumDeploymentIdentity(
  raw = process.env.CF_VERSION_METADATA,
): FcrStratumDeploymentIdentity | undefined {
  if (raw === undefined || raw.length === 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
  const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp.trim() : "";
  if (id.length === 0 || timestamp.length === 0) return undefined;

  const tag = typeof parsed.tag === "string" && parsed.tag.trim().length > 0
    ? parsed.tag.trim()
    : undefined;
  const normalizedTag = tag?.toLowerCase();
  const sourceCommitClaim = normalizedTag !== undefined && GIT_SHA_40.test(normalizedTag)
    ? normalizedTag
    : undefined;

  return {
    source: FCR_STRATUM_DEPLOYMENT_IDENTITY_SOURCE,
    workerVersionId: id,
    workerVersionTimestamp: timestamp,
    ...(tag !== undefined ? { workerVersionTag: tag } : {}),
    ...(sourceCommitClaim !== undefined
      ? {
          sourceCommitClaim,
          sourceCommitClaimSource: "worker-version-tag" as const,
        }
      : {}),
  };
}
