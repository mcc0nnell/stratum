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

## Deployment authority stays outside Stratum

Stratum does not upload, prove, or promote a Worker version as part of this FCR slice. The application is only a passive runtime identity producer.

A deployment that wants this field must supply Cloudflare's Version Metadata binding:

```toml
[version_metadata]
binding = "CF_VERSION_METADATA"
```

Cloudflare Wrangler bindings are non-inheritable, so named environments need the same binding in their own environment configuration rather than relying on the top-level binding.

For the assurance path, an external release authority should:

1. materialize the intended immutable source object;
2. prepare the deployment configuration, including Version Metadata, outside Stratum's decision path;
3. upload a Worker version tagged with the source-object claim;
4. preserve the exact uploaded version identity and runtime module bytes;
5. independently compare those bytes with the bundle produced for that source object;
6. promote that exact Worker version only after the external proof passes.

WindAnvil's generic Cloudflare Worker source-binding work is the first implementation of that pattern. Stratum does not call WindAnvil and cannot convert an assurance result into merge authority.

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
immutable source object X
        ↓
external Worker upload + byte proof
        ↓
Cloudflare Worker version V
        ↓
Stratum runtime reports V in FCR handoff
        ↓
WindAnvil exact-byte handoff capture
        ↓
content-addressed evidence object
        ↓
WindAnvil premise → witness reconstruction
        ↓
WindAnvil witness → advisory reconstruction
```

A separate assurance record can therefore bind `workerVersionId = V` to an externally proven source/bundle relation without letting Stratum self-certify.

The current byte proof still does **not** imply hermetic build provenance: dependency state, Wrangler/toolchain identity, environment, plugins, and other build inputs remain a separate assurance threshold. Keeping that boundary explicit is intentional.
