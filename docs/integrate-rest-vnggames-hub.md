# REST API

Record a run over HTTP from any language. Two ways: the lifecycle flow (open a run, then close it) for a job you track while it runs, or a single one-shot call for a job that already finished.

> workflow_id must be registered in Admin → Workflows before ingestion (unregistered runs are rejected, 422). Each workflow has its own ingest token; source is determined by the server from the integration.

## Key inputs

An integration needs just these three values — only workflow_id and token are required.

- **workflow_id** — The registered id you send runs for — it groups every run on the dashboard. Register it first in Admin → Workflows (unregistered ids are rejected, 422). Goes in track("<id>") or the workflow_id field.
- **token** — Your workflow's ingest token, issued by the admin when it's registered. Authenticates writes — put it in the SDK token option or the Authorization: Bearer header. One token per workflow.
- **actor** (optional) — Who/what ran it, as an email — powers the “distinct actors” metric. You can omit it (runs without an actor are accepted); if you send it, it must be a valid email.

> Lifecycle (start → finish) — best for long or in-progress jobs. POST /runs/start opens a RUNNING run and returns its id; then PATCH /runs/:id closes it with the final status. duration_ms is measured for you (finish time − start time), so you can leave it out.

## 1 · Open a run (start)

```sh
curl -X POST https://workflowhub-api.vnggames.net/api/v1/runs/start \
  -H "Authorization: Bearer <YOUR_INGEST_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"workflow_id":"webshop-deploy","actor":"ci"}'
```

## ↳ Response 201 — the new run; id is the RUN_ID for step 2

```json
{
  "id": "3f9a1c2e-7b4d-4e8a-9c1f-2a6b5d8e0f12",
  "workflow_id": "webshop-deploy",
  "status": "RUNNING",
  "source": "http",
  "actor": "ci",
  "started_at": "2026-06-22T08:30:00.000Z",
  "finished_at": null,
  "duration_ms": null,
  "error_message": null,
  "metadata": null,
  "created_at": "2026-06-22T08:30:00.000Z"
}
```

## 2 · Close the run (PATCH /runs/:id)

```sh
curl -X PATCH https://workflowhub-api.vnggames.net/api/v1/runs/<RUN_ID> \
  -H "Authorization: Bearer <YOUR_INGEST_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"status":"SUCCESS"}'
```

## ↳ Response 200 — the closed run (server fills finished_at + duration_ms)

```json
{
  "id": "3f9a1c2e-7b4d-4e8a-9c1f-2a6b5d8e0f12",
  "workflow_id": "webshop-deploy",
  "status": "SUCCESS",
  "source": "http",
  "actor": "ci",
  "started_at": "2026-06-22T08:30:00.000Z",
  "finished_at": "2026-06-22T08:32:03.000Z",
  "duration_ms": 123000,
  "error_message": null,
  "metadata": null,
  "created_at": "2026-06-22T08:30:00.000Z"
}
```

> Valid status values (the server validates against this set — anything else → 400): RUNNING (open / in progress), SUCCESS (finished OK), FAILED (finished with an error — also send error_message), CANCELLED (stopped before finishing), PARTIAL (finished but only partly). RUNNING keeps the run open; the other four are terminal — closing with one of them stamps finished_at and computes duration_ms.

> One-shot — best for a job that already finished. A single POST records the completed run. There's no interval to measure here, so include duration_ms (or explicit started_at + finished_at) — otherwise the duration is recorded as 0.

## One-shot — record a finished run

```sh
curl -X POST https://workflowhub-api.vnggames.net/api/v1/runs \
  -H "Authorization: Bearer <YOUR_INGEST_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"workflow_id":"webshop-deploy","status":"SUCCESS","duration_ms":1234}'
```

## ↳ Response 201 — the recorded run

```json
{
  "id": "7c2b9d4f-1a3e-4b6c-8d0a-5f2e1c9b7a44",
  "workflow_id": "webshop-deploy",
  "status": "SUCCESS",
  "source": "http",
  "actor": null,
  "started_at": "2026-06-22T08:30:00.000Z",
  "finished_at": "2026-06-22T08:30:00.000Z",
  "duration_ms": 1234,
  "error_message": null,
  "metadata": null,
  "created_at": "2026-06-22T08:30:00.000Z"
}
```

> Batch — record up to 500 runs in one request (high volume / offline buffer / import). Partial-success: each item is processed independently and returns its own result (created / duplicate / error), so one bad row never drops the others.

## Batch — many runs at once

```sh
curl -X POST https://workflowhub-api.vnggames.net/api/v1/runs/batch \
  -H "Authorization: Bearer <YOUR_INGEST_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"runs":[{"workflow_id":"webshop-deploy","status":"SUCCESS","duration_ms":1200},{"workflow_id":"webshop-deploy","status":"FAILED","duration_ms":300}]}'
```

## ↳ Response 200 — summary + one result per item

```json
{
  "summary": { "total": 2, "created": 2, "duplicated": 0, "failed": 0 },
  "results": [
    { "index": 0, "status": "created", "id": "7c2b9d4f-1a3e-4b6c-8d0a-5f2e1c9b7a44" },
    { "index": 1, "status": "created", "id": "b8e3f0a1-6c2d-4e9b-9a7f-3d1c5b2e8f06" }
  ]
}
```

> Is duration_ms required? No. Leave it out with start → finish — the server computes it from the time between your two calls. For the one-shot POST /runs, send it (or started_at + finished_at): there's only one request, so there's no elapsed time to measure, and it would otherwise be 0 (skewing p95 / Time saved).
