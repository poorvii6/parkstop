/**
 * Refuse to run a writing script against a database that is not local.
 *
 * backend/.env used to hold the Railway production URL, so every script here
 * wrote to live data by default. test-weekly-payout.js creates users and then
 * deletes them; seed.js and generate-test-data.js insert fixtures;
 * writeoff-booking.js and approve-owner.js change money and access. None of
 * them asked which database they were pointed at.
 *
 * .env now points at a local database and the production URL lives in
 * .env.production, but that is a convention, and a convention is one `export
 * DATABASE_URL=...` away from being broken. This is the check that does not
 * depend on anyone remembering.
 *
 * Local means localhost, 127.0.0.1 or ::1. Anything else needs an explicit
 * --production on the command line, which also prints what it is about to
 * touch so a mistake is visible before the writes start.
 *
 * Usage, as early in the script as possible:
 *
 *   const requireLocalDb = require('./lib/require-local-db');
 *   requireLocalDb({ script: 'seed.js' });
 *
 * Read-only scripts do not need it. It is for anything that writes.
 */
const fs = require('fs');
const path = require('path');

/** The URL the script will actually connect with: env first, then .env. */
function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.join(__dirname, '..', '..', '.env');
  if (!fs.existsSync(envPath)) return null;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    if (line.startsWith('DATABASE_URL=')) {
      return line.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function describe(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: u.port || '5432', db: u.pathname.slice(1) || '(none)' };
  } catch {
    return { host: '(unparseable)', port: '', db: '' };
  }
}

/**
 * @param {object} opts
 * @param {string} opts.script    name shown in the refusal, e.g. 'seed.js'
 * @param {string[]} [opts.argv]  defaults to process.argv
 * @param {string} [opts.what]    one line on what the script writes
 * @returns {{local: boolean, host: string, db: string}}
 */
function requireLocalDb({ script = path.basename(process.argv[1] || 'script'), argv = process.argv, what } = {}) {
  const url = resolveDatabaseUrl();
  if (!url) {
    console.error(`${script}: no DATABASE_URL (env or backend/.env). Nothing to connect to.`);
    process.exit(1);
  }

  const { host, port, db } = describe(url);
  const local = LOCAL_HOSTS.has(host);
  const forced = argv.includes('--production');

  if (local) return { local: true, host, db };

  if (!forced) {
    console.error('');
    console.error(`  ${script} REFUSED TO RUN.`);
    console.error('');
    console.error(`  DATABASE_URL points at ${host}:${port}, database "${db}".`);
    console.error('  That is not a local database, and this script writes.');
    if (what) console.error(`  It would: ${what}`);
    console.error('');
    console.error('  If you meant to run it locally, check backend/.env — it should be');
    console.error('  postgresql://<user>@localhost:5433/parkstop_dev, and the production');
    console.error('  URL belongs in .env.production.');
    console.error('');
    console.error('  If you genuinely meant production, say so:');
    console.error(`      node scripts/${script} --production`);
    console.error('');
    process.exit(1);
  }

  console.warn('');
  console.warn(`  !! ${script} is running against ${host}:${port}, database "${db}".`);
  console.warn('  !! --production was passed, so this is NOT a drill.');
  if (what) console.warn(`  !! It will: ${what}`);
  console.warn('');
  return { local: false, host, db };
}

module.exports = requireLocalDb;
module.exports.resolveDatabaseUrl = resolveDatabaseUrl;
