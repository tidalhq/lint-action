---
name: release
description: Bump package version, commit all changes, tag release, retag major, push commit and tags.
metadata:
  short-description: Release helper
---

# Release Skill

Use this skill when the user asks to release or “commit, bump, and push tags”.

## Workflow

1) **Preflight**
   - Run `git status --short --branch` and confirm the repo is clean or that all changes should be included.
   - Read current version from `package.json` (Node): `node -p "require('./package.json').version"`.
   - Determine the major tag name to move (e.g., `v2` for `2.x.x`).

2) **Version bump**
   - Bump patch unless the user specified.
   - Command: `npm version patch --no-git-tag-version`.
   - If the user specifies a version or bump type, use that instead (`minor`, `major`, or explicit `x.y.z`).

3) **Build (if applicable)**
   - If the repo bundles artifacts (e.g., `dist/` via `ncc`), rebuild after the version bump so the bundled version is correct.
   - Typical command: `yarn build` (or project-specific build step).

4) **Commit**
   - Stage all relevant changes for the release (including rebuilt artifacts).
   - Commit message format:
     - Subject: `Release vX.Y.Z` (use new version)
     - Optional body: short bullets describing key changes if already known.

5) **Tagging**
   - Create annotated tag for the new version: `git tag -a vX.Y.Z -m "vX.Y.Z"`.
   - Retag the major alias to the new commit (e.g., `v2`): `git tag -f v2`.

6) **Push**
   - Push branch: `git push origin <branch>`.
   - Push tags: `git push origin vX.Y.Z` and force-push the major alias tag: `git push -f origin v2`.
   - If network fails, rerun with escalation per environment rules.

## Notes

- If there are unrelated local changes, ask before including them.
- Always report the final commit SHA and the tags pushed.
