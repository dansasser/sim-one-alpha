# HEARTBEAT.md

## Purpose

Defines scheduled or recurring task notes for the main AI employee.

## Status

Scheduled-task support exists via the `src/schedules/` subsystem and the `schedule_*` tools. HEARTBEAT.md now drives recurring heartbeat-style work; create a schedule with `schedule_create` to run a HEARTBEAT review on a cron. Schedule definitions and run history are durable in SQLite (`.gorombo/db/schedules.sqlite`); firing uses Croner in-process and rehydrates from SQLite on restart.

## Example

- Daily: review open executive priorities and identify any blocked follow-ups.

## Scheduling a HEARTBEAT review

Create a recurring schedule (orchestrator-owned tool, scope derived from the trusted chat event):

```text
schedule_create:
  slug: heartbeat-daily-review
  kind: cron
  schedule: "0 9 * * *"        # 09:00 UTC daily
  prompt: "Review HEARTBEAT.md open executive priorities and report any blocked follow-ups."
  targetAgent: orchestrator
```

One-shot reminders use `kind: "at"` with an ISO 8601 timestamp (auto-deletes after the run). Pause, resume, force-fire, and inspect run history with `schedule_pause` / `schedule_resume` / `schedule_run_now` / `schedule_runs`. Operators can also manage schedules via the admin HTTP route (`/api/schedules/*`, behind the API secret).

## Tasks

Recurring tasks, recurrence rules, and expected outputs live here. Add a task as a schedule via `schedule_create`; this file is the human-readable companion the agent consults.