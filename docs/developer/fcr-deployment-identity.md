# FCR deployment identity

The FCR Stratum merge handoff can optionally bind the running Cloudflare Worker version that emitted it. This is provenance for the OBSERVE-only reasoning package, not merge authority.

## Runtime identity

Cloudflare's Version Metadata binding exposes the running Worker version id, optional version tag, and version creation timestamp. With Stratum's `nodejs_compat` configuration and compatibility date, configured version metadata is also available through `process.env`.

When present, `fcr.stratum.merge-handoff.v1` carries:

```json
{
  "producerDeployment": {
    "source": "cloudflare.worker.version-metadata",
    "workerVersionId": "...",
    "workerVersionTimestamp": "...",
    "workerVersionTag": "..."
  }
}
```

If the Worker version tag is exactly a 40-hex Git-shaped value, the handoff also carries:

```json
{
  "sourceCommitClaim": "0123456789abcdef0123456789abcdef01234567",
  "sourceCommitClaimSource": "worker-version-tag"
}
```

The word **claim** is deliberate. A Worker version tag binds that string to a Cloudflare Worker version; it does not by itself prove that the deployed Worker bytes were built from the corresponding Git object.

When version metadata is absent or malformed, FCR omits `producerDeployment`. Merge protection remains unchanged.

## External version-tagged deployment

For the FCR proving path, deploy with:

```bash
scripts/deploy-fcr-versioned.sh staging
```

or provide the exact source SHA explicitly:

```bash
scripts/deploy-fcr-versioned.sh staging 0123456789abcdef0123456789abcdef01234567
```

The helper:

1. validates the source SHA;
2. copies `wrangler.toml` to a temporary config in the repository root;
3. adds the Version Metadata binding only to the selected Wrangler environment;
4. runs `wrangler deploy --tag <source-sha>`;
5. deletes the temporary config on exit.

Named Wrangler environments do not inherit bindings, so staging and production receive the binding in their own environment table when selected.

The base `wrangler.toml` is not rewritten by this experimental assurance path. Ordinary self-hosted and maintainer deploy commands therefore retain their existing behavior.

## Authority boundary

Deployment identity does not change the merge decision and does not add a WindAnvil dependency to Stratum's hot path.

The handoff still states:

```json
{
  "authority": {
    "mode": "observe",
    "commitPermitIssued": false
  }
}
```

The version-metadata parser is local and fail-soft: unavailable or malformed metadata results in no deployment identity being attached. An FCR observation failure is still caught by the existing observer boundary and cannot alter Stratum's `allowed` / `reasons` result.

## Trust chain

With the paired WindAnvil work, the intended chain becomes:

```text
Stratum merge-protection reads
        ↓
FCR raw premise handoff
        +
Cloudflare Worker version identity
        ↓
WindAnvil exact-byte capture
        ↓
content-addressed evidence object
        ↓
WindAnvil premise → witness reconstruction
        ↓
WindAnvil witness → advisory reconstruction
```

The remaining source-attestation question is narrower: independently prove that the Worker version tagged with Git SHA `X` was built from Git object `X`. The FCR handoff does not claim that proof exists until a separate assurance source can establish it.
