## 2026-06-21T03:16:22Z
You are the E2E Testing Worker.
Your working directory is: c:\Users\chilly\Desktop\smart-parking-app1 (1)\smart-parking-app1\.agents\worker_e2e
Your task is to implement the E2E testing infrastructure and cases under `c:\Users\chilly\Desktop\smart-parking-app1 (1)\smart-parking-app1\tests\e2e\`.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Instructions:
1. Initialize E2E files under a new folder `tests/e2e/`.
2. Implement:
   - `tests/e2e/helpers/db.js`: Database setup and reset helper using Prisma. Use it to force-reset/seed users (finder & spotter) and parking spots for tests.
   - `tests/e2e/helpers/api.js`: API helper wrapper using native `fetch` (so that we don't need to install any external packages) to execute HTTP operations against the backend server, maintaining authorization JWT headers.
   - `tests/e2e/helpers/finderDriver.js`: Asynchronous finder driver simulation of mobile client states, deep link formatting, fallback modal branding styling, cancel/complete selections.
   - `tests/e2e/helpers/spotterDriver.js`: Spotter driver simulation.
   - `tests/e2e/cases/tier1_feature.test.js`: Tier 1 Feature Coverage tests (using built-in `node:test` and `assert` modules) for logos, deep links, fallback UI, status completion, and receipt page.
   - `tests/e2e/cases/tier2_boundary.test.js`: Tier 2 Boundary Cases for missing apps, url launch failures, mock cancel decisions, invalid inputs, and duplicate payment validations.
   - `tests/e2e/cases/tier3_combination.test.js`: Tier 3 Pairwise Combinations.
   - `tests/e2e/cases/tier4_workload.test.js`: Tier 4 Real-world Workloads (concurrency, dynamic pricing surge payments, cash platform fee updates).
   - `tests/e2e/runner.js`: Orchestrator script to start backend server, seed DB, execute all tests using `node --test tests/e2e/cases/*.test.js`, and gracefully shut down backend server.
3. Write `TEST_INFRA.md` at the project root `c:\Users\chilly\Desktop\smart-parking-app1 (1)\smart-parking-app1\TEST_INFRA.md` detailing the test framework design.
4. Run the runner script using `run_command` (e.g. `node tests/e2e/runner.js`) and confirm that it executes and passes. If any tests fail because the implementation track has not yet modified the frontend payment screens, ensure that the mock client state driver correctly asserts that the mock client logic (and endpoint integrations) succeed.
5. Create a `handoff.md` in your working directory summarizing files created, tests executed, and run output logs.
