const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/rotateio';

async function run() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();
  try {
    console.log('Running migrations from', MIGRATIONS_DIR);
    const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    for (const f of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      console.log('Applying', f);
      await client.query(sql);
    }
    console.log('Migrations complete');
  } catch (err) {
    console.error('Migration error', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
