import { runLeaderboardMaintenance } from './maintenance.runtime.js';

const result = await runLeaderboardMaintenance('reconcile');
process.stdout.write(`${JSON.stringify(result)}\n`);
