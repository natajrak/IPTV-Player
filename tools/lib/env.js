// Load .env into process.env (no overwrite of existing keys)
const fs = require('fs');
const path = require('path');

function loadEnv(scriptDir) {
  const envPath = fs.existsSync(path.resolve(scriptDir, '.env'))
    ? path.resolve(scriptDir, '.env')
    : path.resolve(scriptDir, '../.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf-8').split('\n').forEach((line) => {
    const [key, ...val] = line.trim().split('=');
    if (key && !process.env[key]) {
      process.env[key] = val.join('=').trim().replace(/^['"]|['"]$/g, '');
    }
  });
}

module.exports = { loadEnv };
