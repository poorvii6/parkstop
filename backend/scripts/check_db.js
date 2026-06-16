const db = require('../src/config/database');

async function check() {
  const res = await db.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'users'
  `);
  console.log(res.rows);
  process.exit(0);
}

check();
