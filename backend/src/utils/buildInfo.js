/**
 * Which build is answering a request.
 *
 * WHY THIS EXISTS. /health reported that the service was up and the database
 * reachable, and nothing about WHICH code was saying so. That cannot tell a
 * successful deploy from a failed one:
 *
 *   - when a new container fails to start, Railway keeps the previous one
 *     serving, so /health answers 200 from the OLD build and looks exactly
 *     like a clean deploy
 *   - `npm start` is `prisma migrate deploy && node src/server.js`, so a
 *     migration that fails means the server never starts at all — the
 *     documented 6 Nov 2026 outage
 *
 * On 21 Nov 2026 a merge to main was watched for four and a half minutes:
 * eighteen unbroken 200s, and not one of them established that the new code
 * was live. This module is how that question gets an answer from outside.
 *
 * A PURE FUNCTION of the environment, taking `env` as an argument rather than
 * reading process.env itself, so every branch can be tested without mutating
 * global state. Same reason BookingRefundPolicy takes its inputs.
 */

/**
 * Variable names are verified against docs.railway.com/reference/variables,
 * not assumed. Railway documents the git variables as provided only "if the
 * deploy originated from a GitHub trigger", which is why there is a fallback
 * chain rather than a single lookup.
 */
const COMMIT_VAR = 'RAILWAY_GIT_COMMIT_SHA';
const DEPLOYMENT_VAR = 'RAILWAY_DEPLOYMENT_ID';

/** How much of a SHA is enough to identify a commit by eye. */
const SHORT_SHA_LENGTH = 7;

/**
 * DELIBERATELY NOT REPORTED: RAILWAY_GIT_COMMIT_MESSAGE and
 * RAILWAY_GIT_AUTHOR. /health is public and unauthenticated — it is in the
 * rate-limiter's skip list — a commit message can quote anything that was in
 * the diff, and an author is a named person. A bare SHA against a private
 * repository reveals nothing.
 *
 * @param {Record<string, string|undefined>} env  usually process.env
 * @returns {{ commit: string|null, source: string, deployment_id?: string }}
 */
function resolveBuild(env = {}) {
  const sha = typeof env[COMMIT_VAR] === 'string' ? env[COMMIT_VAR].trim() : '';
  if (sha) {
    return { commit: sha.slice(0, SHORT_SHA_LENGTH), source: 'railway-git' };
  }

  // A CLI or container-image deploy has no SHA. The deployment id is still
  // unique to one deploy, which is what this field is for: telling two
  // deploys apart, not naming a commit.
  const deployment = typeof env[DEPLOYMENT_VAR] === 'string' ? env[DEPLOYMENT_VAR].trim() : '';
  if (deployment) {
    return { commit: null, deployment_id: deployment, source: 'railway-deployment' };
  }

  // Not on Railway: a laptop, or a test run. Say so plainly rather than
  // reporting a commit that cannot be known from here.
  return { commit: null, source: 'local' };
}

module.exports = { resolveBuild, COMMIT_VAR, DEPLOYMENT_VAR, SHORT_SHA_LENGTH };
