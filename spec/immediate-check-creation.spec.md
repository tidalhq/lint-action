# Immediate Check Run Creation

## Design summary
- Create each linter's check run as soon as that linter finishes.
- Continue running remaining linters even if a check run fails to create.
- If a linter auto-fix commits changes, attach that linter's check run to the
  new commit SHA.

## Inputs
- No new inputs.
- Existing inputs (`check_name`, `auto_fix`, `commit`, `neutral_check_on_warning`)
  keep their current meanings.

## Resolution flow
1. For each enabled linter:
   - Run the linter and parse the lint result.
   - If auto-fix + commit are enabled and changes exist, commit and push, then
     refresh `head_sha`.
   - Create the check run immediately for that linter using the current
     `head_sha`.
2. If any check run creation fails, log a warning but continue with remaining
   linters.
3. After all linters finish, fail the action only if lint failures exist and
   `continue_on_error` is false.

## Logging
- Each linter logs check creation success or failure during its own group.
- A final warning is emitted if any check run creation failed.

## Key implementation points
- `src/index.js` calls `createCheck` inside the per-linter loop.
- `head_sha` is updated after an auto-fix commit to ensure annotations target the
  correct commit.

## Notes
- This is not a fail-fast change; all linters still run.
- Check creation errors do not fail the action on their own.
