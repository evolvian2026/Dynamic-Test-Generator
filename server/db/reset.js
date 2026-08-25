import fs from 'node:fs';
import config from '../config.js';
import { closeDb } from './index.js';

closeDb();
for (const suffix of ['', '-wal', '-shm']) {
  const file = `${config.databasePath}${suffix}`;
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    console.log(`Removed ${file}`);
  }
}
console.log('Database reset. Run `npm run migrate && npm run seed` to rebuild.');
