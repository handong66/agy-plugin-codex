/**
 * The one place the version policy lives, so `scripts/validate-plugin.mjs` and
 * `test/version-sync.test.ts` cannot disagree about it.
 *
 * The rule exists because sibling plugins in this family have shipped as
 * `0.2.1+codex.20260711160539` -- a version that never matched their own
 * package.json. A local cachebuster is how you make an installed plugin cache pick
 * up a rebuild during development; it must never survive into a release tag.
 */
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const CACHEBUSTER = /^codex\.\d{8,}$/;

export function releaseVersionIssues({
  manifestVersion,
  packageVersion,
  releaseTags = [],
  releaseEnv
}) {
  const errors = [];
  const warnings = [];

  if (typeof manifestVersion !== "string" || !SEMVER.test(manifestVersion)) {
    errors.push(`plugin version must be semver, got ${JSON.stringify(manifestVersion)}`);
    return { errors, warnings };
  }

  const [releaseCore, buildMetadata] = manifestVersion.split("+");
  if (releaseCore !== packageVersion) {
    errors.push(
      `plugin.json version ${manifestVersion} advertises release ${releaseCore || "(none)"}, ` +
        `but the built code is package.json ${packageVersion}`
    );
  }
  if (!buildMetadata) return { errors, warnings };

  if (!CACHEBUSTER.test(buildMetadata)) {
    errors.push(
      `plugin.json build metadata +${buildMetadata} is not a recognised local cachebuster ` +
        "(expected +codex.<timestamp>)"
    );
    return { errors, warnings };
  }

  const isRelease = releaseTags.length > 0 || releaseEnv === "1";
  if (isRelease) {
    errors.push(
      `release commit must not carry the local cachebuster +${buildMetadata} ` +
        `(tags at HEAD: ${releaseTags.join(", ") || "none"}; AGY_PLUGIN_RELEASE=${releaseEnv ?? "unset"}). ` +
        `Set plugin.json version to ${releaseCore}.`
    );
  } else {
    warnings.push(
      `plugin.json carries the local cachebuster +${buildMetadata}; drop it before cutting a release tag.`
    );
  }
  return { errors, warnings };
}
