const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
for (const name of ['node_modules', 'package-lock.json']) fs.rmSync(path.join(root, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
