/**
 * Unit tests for resolveBuild — the build identity reported by /health.
 *
 * WHAT THIS IS FOR. /health reported that the service was up and said nothing
 * about which code was answering. That cannot distinguish a successful deploy
 * from a failed one, because when a new container fails to start Railway keeps
 * the previous one serving: /health answers 200 from the OLD build and looks
 * exactly like success. A merge on 21 Nov 2026 was watched for four and a half
 * minutes — eighteen unbroken 200s — and none of them established that the new
 * code was live.
 *
 * So the field's whole value is being WRONG-PROOF. A `commit` that is stale,
 * invented, or quietly absent is worse than no field at all, because it would
 * be trusted. Hence the fallback chain is tested exhaustively rather than
 * sampled.
 *
 * resolveBuild takes env as an argument, so nothing here mutates process.env.
 * Runs with NO database.
 *   npx jest tests/unit/buildInfo.test.js
 */

const {
  resolveBuild, COMMIT_VAR, DEPLOYMENT_VAR, SHORT_SHA_LENGTH,
} = require('../../src/utils/buildInfo');

const SHA = 'd0beb8f5c55b36df7d674d55965a23b8d54ad69b';

describe('resolveBuild — variable names', () => {
  it('reads the names Railway actually documents', () => {
    // Verified against docs.railway.com/reference/variables. If someone
    // "tidies" these to a guessed name, /health silently reports source
    // 'local' in production for ever and the field becomes useless.
    expect(COMMIT_VAR).toBe('RAILWAY_GIT_COMMIT_SHA');
    expect(DEPLOYMENT_VAR).toBe('RAILWAY_DEPLOYMENT_ID');
  });
});

describe('resolveBuild — deployed from GitHub', () => {
  const env = { [COMMIT_VAR]: SHA, [DEPLOYMENT_VAR]: 'dep-123' };

  it('reports the short commit', () => {
    expect(resolveBuild(env).commit).toBe('d0beb8f');
    expect(resolveBuild(env).commit).toHaveLength(SHORT_SHA_LENGTH);
  });

  it('says where that came from', () => {
    expect(resolveBuild(env).source).toBe('railway-git');
  });

  it('prefers the commit over the deployment id when it has both', () => {
    // A SHA answers "which build" directly; a deployment id only answers it
    // indirectly, via the Railway dashboard.
    expect(resolveBuild(env).deployment_id).toBeUndefined();
  });

  it('is a prefix of the full SHA, so it can be matched against git log', () => {
    expect(SHA.startsWith(resolveBuild(env).commit)).toBe(true);
  });

  it('tolerates whitespace around the value', () => {
    expect(resolveBuild({ [COMMIT_VAR]: `  ${SHA}\n` }).commit).toBe('d0beb8f');
  });

  it('does not pad a SHA shorter than the short length', () => {
    expect(resolveBuild({ [COMMIT_VAR]: 'abc' }).commit).toBe('abc');
  });
});

describe('resolveBuild — deployed by CLI or image (no git trigger)', () => {
  // Railway documents the git variables as provided only "if the deploy
  // originated from a GitHub trigger", so this is a real state, not a
  // hypothetical one.
  const env = { [DEPLOYMENT_VAR]: 'dep-abc-123' };

  it('falls back to the deployment id', () => {
    expect(resolveBuild(env)).toEqual({
      commit: null, deployment_id: 'dep-abc-123', source: 'railway-deployment',
    });
  });

  it('reports commit as null rather than inventing one', () => {
    // The failure that matters: a plausible-looking wrong commit would be
    // trusted. null is honest and visibly unusable.
    expect(resolveBuild(env).commit).toBeNull();
  });

  it('still distinguishes two deploys from each other', () => {
    const a = resolveBuild({ [DEPLOYMENT_VAR]: 'dep-one' });
    const b = resolveBuild({ [DEPLOYMENT_VAR]: 'dep-two' });
    expect(a.deployment_id).not.toBe(b.deployment_id);
  });
});

describe('resolveBuild — not on Railway', () => {
  it('reports local for an empty environment', () => {
    expect(resolveBuild({})).toEqual({ commit: null, source: 'local' });
  });

  it('reports local when called with no argument at all', () => {
    expect(resolveBuild()).toEqual({ commit: null, source: 'local' });
  });

  it('never claims a commit it cannot know', () => {
    expect(resolveBuild({}).commit).toBeNull();
  });
});

describe('resolveBuild — absent, blank and malformed values', () => {
  // An empty string is what an unset-but-declared Railway variable looks
  // like. Treating '' as present would report commit: '' — a field that is
  // there, looks fine in a dashboard, and says nothing.
  const blankish = ['', '   ', '\n', '\t'];

  it.each(blankish)('treats a blank commit (%j) as absent', (v) => {
    expect(resolveBuild({ [COMMIT_VAR]: v }).source).toBe('local');
    expect(resolveBuild({ [COMMIT_VAR]: v }).commit).toBeNull();
  });

  it.each(blankish)('treats a blank deployment id (%j) as absent', (v) => {
    expect(resolveBuild({ [DEPLOYMENT_VAR]: v }).source).toBe('local');
  });

  it('falls through a blank commit to a usable deployment id', () => {
    const r = resolveBuild({ [COMMIT_VAR]: '  ', [DEPLOYMENT_VAR]: 'dep-9' });
    expect(r.source).toBe('railway-deployment');
    expect(r.deployment_id).toBe('dep-9');
  });

  it.each([undefined, null, 123, {}, [], true])('ignores a non-string commit (%j)', (v) => {
    expect(resolveBuild({ [COMMIT_VAR]: v }).source).toBe('local');
  });

  it('does not throw on a hostile environment object', () => {
    expect(() => resolveBuild(Object.create(null))).not.toThrow();
  });
});

describe('resolveBuild — what must never be exposed', () => {
  it('reports no commit message and no author', () => {
    /*
     * /health is public and unauthenticated — it is in the rate-limiter's
     * skip list. A commit message can quote anything that was in the diff,
     * and an author is a named person. Neither belongs on an open endpoint,
     * so if someone adds them here this test is the objection.
     */
    const env = {
      [COMMIT_VAR]: SHA,
      RAILWAY_GIT_COMMIT_MESSAGE: 'Fix the thing for a customer',
      RAILWAY_GIT_AUTHOR: 'some-github-handle',
      RAILWAY_GIT_BRANCH: 'main',
    };
    const serialized = JSON.stringify(resolveBuild(env));
    expect(serialized).not.toMatch(/customer/i);
    expect(serialized).not.toMatch(/some-github-handle/);
    expect(Object.keys(resolveBuild(env)).sort()).toEqual(['commit', 'source']);
  });

  it('returns only the keys /health is meant to publish', () => {
    const allowed = ['commit', 'deployment_id', 'source'];
    for (const env of [{}, { [COMMIT_VAR]: SHA }, { [DEPLOYMENT_VAR]: 'd' }]) {
      for (const key of Object.keys(resolveBuild(env))) {
        expect(allowed).toContain(key);
      }
    }
  });
});
