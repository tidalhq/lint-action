# Check Suite Linking (Simple)

## Design summary
- Link created checks to the workflow suite only when the current job check run ID is provided.
- Avoid heuristics, retries, and fallback paths to keep behavior deterministic and “official”.
- Expose minimal debug logs when `check_suite_debug` is true to aid investigation without noisy payloads.

## Inputs
- `check_suite_job_check_run_id`: Optional check run ID for the current job (use `${{ job.check_run_id }}`).
- `check_suite_debug`: When true, emit structured logs prefixed with `[check-suite-debug]`.

## Resolution flow
1. If `check_suite_job_check_run_id` is missing or invalid, skip suite linking and create checks without `check_suite_id`.
2. If provided, call `GET /repos/{owner}/{repo}/check-runs/{id}` and read `check_suite.id` and `head_sha`.
3. If a suite ID is found, attach `check_suite_id` to check creation and use the resolved `head_sha` for check runs.
4. If missing or API error, log a warning and create checks without `check_suite_id`.

## Logging (debug)
Emitted via `core.info` when `check_suite_debug` is true:
- `suite-resolution-skipped` with reason `missing-job-check-run-id`
- `suite-resolution-start` with `jobCheckRunId`
- `suite-resolution-response` with a sanitized snapshot of the job check run response (id, head_sha, status, conclusion, check_suite.id)
- `suite-resolution-result` with `jobCheckRunId`, `checkSuiteId`, and `checkRunHeadSha`
- `suite-resolution-error` with `jobCheckRunId` and `errorMessage`
- `suite-resolution-apply` with `jobCheckRunId`, resolved suite info, chosen `checkHeadSha`, and check names

## Key implementation points
- `src/index.js` reads and validates `check_suite_job_check_run_id`, passes it to the suite resolver with `debug`.
- `src/github/api.js` implements `getCurrentRunCheckSuiteInfo` to resolve `checkSuiteId` and `checkRunHeadSha` from `jobCheckRunId`, and logs a sanitized response snapshot when debug is enabled.
- `createCheck` includes `check_suite_id` only when a suite ID is resolved.
- Tests updated to cover: missing ID, resolved suite, missing suite, and error path.

## Notes
- This intentionally removes job-name hinting, workflow-run lookups, commit fallbacks, and retry logic.
- If suite resolution fails, checks still get created (unlinked).
