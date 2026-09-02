import { runLeaderboardMaintenance } from './maintenance.runtime.js';

const result = await runLeaderboardMaintenance('rebuild');
process.stdout.write(`${JSON.stringify(result)}\n`);
