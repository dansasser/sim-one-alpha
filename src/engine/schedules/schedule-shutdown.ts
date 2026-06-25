/**
 * Graceful shutdown for the schedules subsystem (plan §7 shutdown flow).
 *
 * On SIGTERM/SIGINT (covers `pm2 stop` / `systemctl stop`), emit a
 * `schedule.shutdown` event, stop accepting new Croner fires, stop all Croner
 * jobs, and resolve any in-flight observations as `timeout` (the underlying
 * Flue agent submissions are aborted at the turn boundary by Flue's own
 * graceful-shutdown path and left reclaimable — see the durable-execution doc;
 * we do not duplicate that reconciliation here).
 *
 * The grace window is advisory for v1: `manager.stop()` resolves pending
 * observations immediately so the process can exit promptly. Flue's
 * submission reconciliation (resume/reclaim on next startup) handles the
 * durable side.
 */

import type { ScheduleManager } from '../../engine/schedules/schedule-manager.js';
import { scheduleProgressEmitter } from '../../engine/schedules/schedule-manager.js';

export interface ScheduleShutdownOptions {
  /** Advisory grace window in seconds (v1: informational; stop() is synchronous). */
  graceSeconds?: number;
  /** Logger; defaults to console.error. */
  log?: (message: string) => void;
}

let installed = false;

/**
 * Register SIGTERM/SIGINT handlers that drain the ScheduleManager. Idempotent.
 */
export function registerScheduleShutdown(
  manager: ScheduleManager,
  options: ScheduleShutdownOptions = {},
): void {
  if (installed) {
    return;
  }
  installed = true;
  const log = options.log ?? ((msg) => console.error(`[schedules] ${msg}`));
  const graceSeconds = options.graceSeconds ?? 60;

  const handler = (signal: NodeJS.Signals) => {
    scheduleProgressEmitter('schedule.shutdown', { signal, graceSeconds });
    log(`received ${signal}; draining schedule manager (grace ${graceSeconds}s)`);
    try {
      manager.stop();
    } catch (error) {
      log(`schedule manager stop error: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Let Flue's own graceful-shutdown path handle in-flight agent submissions.
  };

  process.once('SIGTERM', handler);
  process.once('SIGINT', handler);
}