# Check Suite Linking (Disabled)

## Design summary
- Do not link created checks to a workflow suite.
- Create top-level check runs (ESLint/TypeScript/Prettier, etc.) directly on the commit.
- `check_suite_job_check_run_id` and `check_suite_debug` are accepted but ignored.

## Inputs
- `check_suite_job_check_run_id`: Deprecated (ignored).
- `check_suite_debug`: Deprecated (ignored).

## Resolution flow
1. Always create check runs with `head_sha` only.
2. Do not set `check_suite_id`.

## Logging (debug)
No check-suite debug logging is emitted.

## Key implementation points
- `src/index.js` creates checks with `head_sha` only.
- `createCheck` never sets `check_suite_id`.

## Notes
- This intentionally avoids suite linking, so checks appear as top-level check runs.
- GitHub discussion context: https://github.com/orgs/community/discussions/24616#discussioncomment-5607870
