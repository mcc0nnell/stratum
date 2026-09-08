#!/usr/bin/env bash
set -euo pipefail

# Deploy Stratum with Cloudflare Version Metadata enabled and tag the exact
# Worker version with a Git-shaped source commit claim. This is an external/local
# deployment helper; it does not use GitHub Actions and does not make Stratum's
# merge path depend on WindAnvil.

usage() {
  cat >&2 <<'EOF'
usage: scripts/deploy-fcr-versioned.sh <default|staging|production> [source-sha]

source-sha defaults to `git rev-parse HEAD` and must be a canonical 40-hex SHA.
EOF
  exit 2
}

[[ $# -ge 1 && $# -le 2 ]] || usage

environment="$1"
case "$environment" in
  default|staging|production) ;;
  *) usage ;;
esac

source_sha="${2:-$(git rev-parse HEAD)}"
source_sha="$(printf '%s' "$source_sha" | tr '[:upper:]' '[:lower:]')"
[[ "$source_sha" =~ ^[a-f0-9]{40}$ ]] || {
  echo "source-sha must be a canonical 40-hex Git SHA" >&2
  exit 2
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

tmp_config=".wrangler.fcr-versioned.$$.toml"
cleanup() {
  rm -f "$tmp_config"
}
trap cleanup EXIT

cp wrangler.toml "$tmp_config"

case "$environment" in
  default)
    cat >>"$tmp_config" <<'EOF'

# Added by deploy-fcr-versioned.sh. The base config remains unchanged so this
# experimental assurance binding cannot alter ordinary self-hosted deployments.
[version_metadata]
binding = "CF_VERSION_METADATA"
EOF
    env_args=()
    ;;
  staging|production)
    cat >>"$tmp_config" <<EOF

# Added by deploy-fcr-versioned.sh for the selected named environment. Wrangler
# bindings are not inherited into named environments.
[env.${environment}.version_metadata]
binding = "CF_VERSION_METADATA"
EOF
    env_args=(--env "$environment")
    ;;
esac

echo "Deploying Stratum environment=$environment with Worker version tag=$source_sha" >&2
npx wrangler deploy --config "$tmp_config" "${env_args[@]}" --tag "$source_sha"
