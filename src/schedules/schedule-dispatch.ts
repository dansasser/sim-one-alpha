/**
 * Thin wrapper around Flue `dispatch(...)` for scheduled agent turns.
 *
 * Dispatch is ADMISSION-ONLY (see `schedule-types.ts` + memory
 * `flue-dispatch-contract`): `dispatch(...)` returns a `DispatchReceipt` with
 * only `{ dispatchId, acceptedAt }` and admits the input to the agent's
 * continuing durable queue; the turn runs asynchronously. This wrapper admits
 * and returns the receipt — it does NOT await the turn completing. The terminal
 * status is observed separately by `schedule-manager.ts` via `observe()`.
 *
 * Flue agent-discovery constraint (see memory `flue-agent-discovery-subagents`):
 * only `orchestrator` is a Flue-discovered dispatchable agent module
 * (`src/agents/orchestrator.ts`). `coding-worker` is a subagent profile, NOT a
 * separately addressable agent endpoint. So this wrapper ALWAYS dispatches to
 * `orchestrator`. `targetAgent` is carried in the input as the intended handler:
 * for `coding-worker`, the orchestrator delegates to the coding-worker subagent
 * via its `task` tool per its workspace instructions (orchestrator.ts:164). Do
 * NOT call `dispatch({ agent: 'coding-worker' })` — it is invalid.
 */

import { dispatch, type DispatchReceipt } from '@flue/runtime';

import type { ScheduleRunInput, ScheduleTargetAgent } from './schedule-types.js';

/** The single Flue-discovered agent module name this repo exposes in v1. */
const DISPATCH_AGENT_MODULE = 'orchestrator';

export interface ScheduleDispatchResult {
  dispatchId: string;
  acceptedAt: string;
  /** The agent instance id passed to dispatch (unique per fire). */
  instanceId: string;
}

export interface DispatchScheduleArgs {
  /** Unique per-fire agent instance id (e.g. `schedule:<scheduleId>:<runId>`). */
  instanceId: string;
  /** Intended handler: orchestrator handles inline; coding-worker is delegated via task. */
  targetAgent: ScheduleTargetAgent;
  /** The dispatch input payload. The wrapper adds `type`, `instanceId`, and `targetAgent`. */
  input: Omit<ScheduleRunInput, 'type' | 'instanceId' | 'targetAgent'>;
}

/**
 * Admit a scheduled turn to the orchestrator agent's durable queue. Resolves
 * when the input is accepted for delivery (NOT when the turn completes). The
 * caller (schedule-manager) observes the turn to terminal via `observe()`.
 */
export function dispatchSchedule(args: DispatchScheduleArgs): Promise<ScheduleDispatchResult> {
  const input: ScheduleRunInput = {
    ...args.input,
    type: 'schedule',
    instanceId: args.instanceId,
    targetAgent: args.targetAgent,
  };
  return dispatch({
    agent: DISPATCH_AGENT_MODULE,
    id: args.instanceId,
    input,
  }).then((receipt: DispatchReceipt) => ({
    dispatchId: receipt.dispatchId,
    acceptedAt: receipt.acceptedAt,
    instanceId: args.instanceId,
  }));
}

export { type DispatchReceipt };