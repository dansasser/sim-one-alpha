/**
 * Side-effect boot target for the schedules subsystem (plan §5, §7).
 *
 * `src/app.ts` imports this module for its side effect, mirroring
 * `./models/runtime.js`. On import it:
 *   1. loads the schedules config block from `GoromboConfig.schedules`;
 *   2. skips entirely if disabled (or `GOROMBO_SKIP_SCHEDULES=1`);
 *   3. installs schedule telemetry (wires the manager's progress emitter);
 *   4. constructs + starts the ScheduleManager singleton (schema, cleanup,
 *      observe subscription, rehydrate enabled schedules);
 *   5. registers SIGTERM/SIGINT drain.
 *
 * A failure to start the schedules subsystem MUST NOT crash the app — it is
 * logged and the manager is left unset so the rest of SIM-ONE Alpha runs
 * normally. Callers use `getScheduleManager()` which returns `null` when
 * schedules are disabled or failed to start; tools/routes handle the null case.
 */

import { loadGoromboConfig } from '../../core/config/gorombo-config.js';
import { resolveScheduleConfig, type SchedulesConfig } from '../../engine/schedules/schedule-config.js';
import { ScheduleManager } from '../../engine/schedules/schedule-manager.js';
import { installScheduleTelemetry } from '../../engine/schedules/schedule-telemetry.js';
import { registerScheduleShutdown } from '../../engine/schedules/schedule-shutdown.js';

let manager: ScheduleManager | null = null;
let started = false;

function start(): void {
  if (started) {
    return;
  }
  started = true;

  let config: SchedulesConfig;
  try {
    const gorombo = loadGoromboConfig();
    config = resolveScheduleConfig(gorombo.schedules as Record<string, unknown> | undefined);
  } catch (error) {
    console.error(`[schedules] config load failed; schedules disabled: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  if (!config.enabled) {
    // Disabled via config or GOROMBO_SKIP_SCHEDULES=1 — start nothing.
    return;
  }

  // In test mode, do not start the real manager (opening a real schedules DB /
  // subscribing observe would interfere with the test suite). Tests that need
  // a manager construct one directly with injected fakes. Mirrors the
  // GOROMBO_TEST_MODE guard in src/session/session-persistence.ts.
  if (process.env.GOROMBO_TEST_MODE === '1' || process.env.NODE_ENV === 'test') {
    return;
  }

  try {
    installScheduleTelemetry();
    manager = new ScheduleManager({ config });
    manager.start();
    registerScheduleShutdown(manager, { graceSeconds: config.shutdownGraceSeconds });
  } catch (error) {
    console.error(`[schedules] manager start failed; schedules disabled: ${error instanceof Error ? error.message : String(error)}`);
    manager = null;
  }
}

/** Access the schedule manager singleton (null if disabled or failed to start). */
export function getScheduleManager(): ScheduleManager | null {
  if (!started) {
    start();
  }
  return manager;
}

/** Whether schedules are active. */
export function schedulesEnabled(): boolean {
  return getScheduleManager() !== null;
}

/**
 * Test-only: inject a ScheduleManager (or null) bypassing the normal boot
 * path, so route/handler tests can exercise the admin route against a real
 * manager with a temp DB + fake dispatch. Not for production use.
 */
export function __setScheduleManagerForTesting(next: ScheduleManager | null): void {
  manager = next;
  started = true;
}

// Side effect on import: boot the subsystem.
start();