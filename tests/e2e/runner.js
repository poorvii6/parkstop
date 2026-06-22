const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const backendDir = path.resolve(__dirname, '../../backend');
const envPath = path.join(backendDir, '.env');

// Load environment variables from backend/.env
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

// Global PORT config
const PORT = process.env.PORT || '3000';
const HEALTH_URL = `http://localhost:${PORT}/health`;

async function main() {
  console.log('⚡ Starting E2E Test Suite Orchestrator...');

  // 1. Sync Database Schema using Prisma
  console.log('📦 Syncing database schema via Prisma db push...');
  try {
    execSync('npx prisma db push', { cwd: backendDir, stdio: 'inherit' });
    console.log('✅ Database schema synced successfully.');
  } catch (err) {
    console.error('❌ Failed to sync database schema:', err.message);
    process.exit(1);
  }

  // 2. Start the Backend Server
  console.log(`🚀 Starting backend server on port ${PORT}...`);
  const serverProcess = spawn('node', ['src/server.js'], {
    cwd: backendDir,
    stdio: 'inherit',
    env: { ...process.env, PORT }
  });

  serverProcess.on('error', (err) => {
    console.error('❌ Server failed to start:', err);
    process.exit(1);
  });

  // Handle server process exit early
  let serverExited = false;
  serverProcess.on('exit', (code) => {
    serverExited = true;
    console.log(`⚠️ Server process exited with code ${code}`);
  });

  // 3. Poll Health Endpoint until ready
  console.log('🔍 Waiting for backend server health-check to respond...');
  let isReady = false;
  for (let attempt = 1; attempt <= 30; attempt++) {
    if (serverExited) break;
    try {
      const res = await fetch(HEALTH_URL);
      if (res.status === 200) {
        const data = await res.json();
        if (data.database === 'connected') {
          isReady = true;
          break;
        }
      }
    } catch (err) {
      // Ignore connection errors during startup
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (!isReady) {
    console.error('❌ Backend server failed to respond to health check in time.');
    serverProcess.kill();
    process.exit(1);
  }
  console.log('✅ Backend server is online and connected to the database.');

  // 4. Run database seed/reset before launching tests
  console.log('🌱 Seeding database for E2E tests...');
  try {
    const { resetDB, seedDB } = require('./helpers/db');
    await resetDB();
    await seedDB();
    console.log('✅ Database seeded.');
  } catch (err) {
    console.error('❌ Database seeding failed:', err);
    serverProcess.kill();
    process.exit(1);
  }

  // 5. Find and execute all test cases
  console.log('🏃 Executing test cases...');
  const casesDir = path.resolve(__dirname, 'cases');
  const testFiles = fs.readdirSync(casesDir)
    .filter(file => file.endsWith('.test.js'))
    .map(file => path.join(casesDir, file));

  if (testFiles.length === 0) {
    console.error('❌ No test cases found in cases/ directory.');
    serverProcess.kill();
    process.exit(1);
  }

  console.log(`Found test files:\n - ${testFiles.join('\n - ')}`);

  // Spawn node test runner
  const testProcess = spawn('node', ['--test', '--test-concurrency=1', ...testFiles], {
    stdio: 'inherit',
    env: { ...process.env, PORT }
  });

  testProcess.on('close', (code) => {
    console.log(`🏁 Test suite finished with exit code: ${code}`);

    // 6. Gracefully shut down backend server
    console.log('🛑 Shutting down backend server...');
    serverProcess.kill('SIGTERM');

    // Wait a brief moment and exit
    setTimeout(() => {
      process.exit(code);
    }, 500);
  });
}

main().catch(err => {
  console.error('❌ Runner encountered an unhandled exception:', err);
  process.exit(1);
});
