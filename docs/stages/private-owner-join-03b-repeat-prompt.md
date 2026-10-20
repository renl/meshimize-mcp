# MCP unknown-repeat prompt correction

Give the operator the same safety information on a repeated unknown-ID join request as on the initial request.

Parent: [slice index](README.md). Owner SDET. Status: setup complete, expected RED; CoS routes SE. First production-hotfix injection for integrated private joining; earlier lease/test corrections do not count as production hotfixes.

## Baseline / delivery

- Worktree: `C:/Users/User/work/projects/meshimize/repos/meshimize-mcp/.worktree/private-owner-join-03b-repeat-prompt`; branch `private-owner-join-03b-repeat-prompt`.
- Full base/current HEAD: `957992f5976396b5c190f38c08ad1b5df040b493`, fetched `origin/main` on 2026-10-20. Prerequisite: existing known-ID implementation landed on MCP main (explicit satellite target exception authorized by CoS).
- Delivery: one legacy hotfix PR to MCP `main`, not root main. No PR creation/merge/publication in this setup. Current prepared version `0.1.20` remains unchanged; no extra unpublished patch bump.
- Both new files and index are uncommitted, readable in this worktree. No helper pin needed.

## Contract / acceptance / allowlist

Authority: root `docs/architecture/features/private-group-invitations.md` §14.2–14.3, US-PGI-8, Architect findings in root `.worktree/private-owner-join-06a-public-prerequisites/docs/stages/private-owner-join-06f-contract-cycle1.md`, and CoS's exact correction dispatch.

Founder-visible success: an operator sees the full intended UUID and all consent warnings even when asking again, without granting access or issuing another network request.

- Unknown initial AND repeat message: full UUID; details and eligibility unverified; compare ID with trusted source before approval; approval only attempts join and may be denied.
- Production allowlist: **only `src/tools/groups.ts` unknown repeat message selection/text**. Keep public-discovery prompts byte-equivalent. Do not change initial semantics, status, pending request ID, TTL/expiry, metadata/nulls, authority continuation, approval/rejection behavior, identity, readiness, API writes/reads or permissions. Reusing existing warning text is permitted, no private helper layout prescribed.
- SDET-owned files: `tests/unknown-prompt.test.ts`, this spec, `docs/stages/README.md`. SE must not edit test criteria. No manifest/lock/release metadata, unrelated cleanup or test-only production APIs.
- Budget: four final files including production, comfortably below 600 changed lines /20 files; verify final numstat before handoff.

## Tests / measured RED / commands

Canonical shell: Windows PowerShell, Node22; finite pure/in-process commands, each bounded by caller to60s (suite120s). No server, Docker lease or deployment needed for these checks. Existing in-scope root MCP `node_modules` reused via worktree-local junction; no installation/dependency change. This is contract-level supporting evidence, not actual stdio/private-Q&A release proof.

Run in this worktree, in order:

1. `node node_modules/vitest/vitest.mjs run tests/unknown-prompt.test.ts --maxWorkers=1 --minWorkers=1`
2. `node node_modules/vitest/vitest.mjs run --maxWorkers=1 --minWorkers=1` (includes existing public, known-ID and single-write regression checks;120s).
3. `npm run typecheck`; `npm run lint`; `npm run build` (each60s).
4. Before commit: `npm run format`; before push: `npm run format:check`; then `git diff --check`. Never stage unrelated formatter changes; return scope conflict via CoS.

Test mapping: corrected positive and historical broken negative independently exercise the warning assertions; registered MCP tool fresh/repeat cases assert all warning meanings after verifying no join/detail/message/subscription, exactly one membership/discovery read (zero replay), unchanged stored request/expiry/null metadata and continuation. Expected after SE:4PASS, no skips. Tests use public MCP Client/InMemoryTransport, not direct handlers.

Measured 2026-10-20: focused **3PASS/1FAIL, exit1**, only repeat fails missing UUID (also missing warnings). Initial/positive/broken-negative pass; all repeat safety assertions preceding message assertion passed. Typecheck exit0. Log: root `_build/sdet-local/repeat-prompt-setup/mcp-red.log`. Formatting applied only to new test; final scoped check below index evidence. Full regression/build/lint not claimed executed at setup.

## Boundary Verification / review gate

Unchanged, already-reviewed prompt contract; no new external boundary or platform semantics materialized. Public MCP JSON text output remains native; only human-readable unknown-repeat message changes. No endpoint/auth/payload/type/schema/transport modification. No additional network read/write: repeat stays local. Real installed stdio plus HTTP/WS useful-answer proof remains at integrated06 gate after corrected candidate/artifact review, not substituted by mocks here. No new interface-fidelity review required for this exact prompt-only correction; expansion must stop for CoS→Architect. Decomposition checklist1–5: all NO for this standalone correction; no shared fixture or cross-client dependency, no receiver process needed. Existing integrated06 review remains required before lease.

## Lifecycle / next action

SDET owns worktree/branch through verified landing and cleanup; status active. CoS dispatches SE with this allowlist, then SDET verifies candidate independently. Retain junction/worktree until safe landed cleanup; no cleanup performed. No npm/Fly/deploy/new lease/main merge authorized. Full feature remains unverified.
