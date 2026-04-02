# Agent-to-Agent Delegation — Slice 2: MCP Delegation Tools

> **Worktree:** `.worktree/agent-to-agent-delegation-02-mcp-tools`
> **Prerequisite:** Slice 1 merged (meshimize PR #132)
> **Baseline:** `main` (meshimize-mcp repo)

---

## 1. Goal

Add 6 MCP delegation tools to `meshimize-mcp` so AI agents can create, list, accept, complete, and cancel delegations through the MCP protocol. Includes a `DelegationContentBuffer` for transient content (SQ-14 compliant) and TypeScript types that match the server's `DelegationJSON` serializer field-by-field.

---

## 2. MCP Tools (6 total)

| #   | Tool Name             | Method | Server Endpoint                    | Input                                                                                                            |
| --- | --------------------- | ------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | `create_delegation`   | POST   | `/api/v1/delegations`              | `group_id` (req), `description` (req, 1–32000 chars), `target_account_id` (opt), `ttl_seconds` (opt, 300–604800) |
| 2   | `list_delegations`    | GET    | `/api/v1/delegations`              | `group_id` (opt), `state` (opt), `role` (opt: sender/assignee/available), `limit` (opt, 1–100), `after` (opt)    |
| 3   | `get_delegation`      | GET    | `/api/v1/delegations/:id`          | `delegation_id` (req)                                                                                            |
| 4   | `accept_delegation`   | POST   | `/api/v1/delegations/:id/accept`   | `delegation_id` (req)                                                                                            |
| 5   | `complete_delegation` | POST   | `/api/v1/delegations/:id/complete` | `delegation_id` (req), `result` (req, 1–32000 chars)                                                             |
| 6   | `cancel_delegation`   | POST   | `/api/v1/delegations/:id/cancel`   | `delegation_id` (req)                                                                                            |

---

## 3. TypeScript Types — `src/types/delegations.ts`

Must match `DelegationJSON` serializer (`delegation_json.ex`) field-by-field:

```typescript
export type DelegationState = "pending" | "accepted" | "completed" | "cancelled" | "expired";
export type DelegationRoleFilter = "sender" | "assignee" | "available";

/** Metadata-only shape — returned by list, show, accept, cancel. */
export interface DelegationMetadataResponse {
  id: string; // UUID
  state: DelegationState;
  group_id: string; // UUID
  group_name: string;
  sender_account_id: string; // UUID
  sender_display_name: string;
  target_account_id: string | null; // UUID | null
  target_display_name: string | null;
  assignee_account_id: string | null; // UUID | null
  assignee_display_name: string | null;
  expires_at: string; // ISO 8601
  accepted_at: string | null; // ISO 8601 | null
  completed_at: string | null; // ISO 8601 | null
  cancelled_at: string | null; // ISO 8601 | null
  inserted_at: string; // ISO 8601
  updated_at: string; // ISO 8601
}

/** Create response — metadata + transient description. */
export interface DelegationCreateResponse extends DelegationMetadataResponse {
  description: string;
}

/** Complete response — metadata + transient result. */
export interface DelegationCompleteResponse extends DelegationMetadataResponse {
  result: string;
}
```

All 18 fields (16 metadata + 2 transient) verified against `delegation_json.ex` — see §9 boundary verification block.

---

## 4. DelegationContentBuffer — `src/buffer/delegation-content-buffer.ts`

Mirrors `MessageBuffer` pattern for SQ-14 transient content. Stores `description` from create and `result` from complete in memory only — never persisted.

```typescript
interface DelegationContent {
  description?: string; // Stored on create
  result?: string; // Stored on complete
}
```

- Keyed by delegation `id` (UUID string).
- `storeDescription(id, description)` — called after successful create.
- `storeResult(id, result)` — called after successful complete.
- `get(id)` → `DelegationContent | undefined`.
- `delete(id)` — manual cleanup.
- Max entries cap (e.g., 1000) with LRU or oldest-first eviction.

---

## 5. API Client Additions — `src/api/client.ts`

Add 6 methods to `MeshimizeAPI` class. All follow existing patterns (flat params, no nesting).

```typescript
// --- Delegations ---

async createDelegation(body: {
  group_id: string;
  description: string;
  target_account_id?: string;
  ttl_seconds?: number;
}): Promise<{ data: DelegationCreateResponse }>

async listDelegations(params?: {
  group_id?: string;
  state?: DelegationState;
  role?: DelegationRoleFilter;
  limit?: number;
  after?: string;
}): Promise<PaginatedResponse<DelegationMetadataResponse>>

async getDelegation(id: string): Promise<{ data: DelegationMetadataResponse }>

async acceptDelegation(id: string): Promise<{ data: DelegationMetadataResponse }>

async completeDelegation(id: string, body: {
  result: string;
}): Promise<{ data: DelegationCompleteResponse }>

async cancelDelegation(id: string): Promise<{ data: DelegationMetadataResponse }>
```

---

## 6. File Plan

| #   | File                                      | Action | Purpose                                                                                 |
| --- | ----------------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| 1   | `src/types/delegations.ts`                | Create | Type definitions per §3                                                                 |
| 2   | `src/buffer/delegation-content-buffer.ts` | Create | Transient content store per §4                                                          |
| 3   | `src/api/client.ts`                       | Edit   | Add 6 delegation API methods per §5                                                     |
| 4   | `src/tools/delegations.ts`                | Create | 6 MCP tool registrations per §2                                                         |
| 5   | `src/tools/index.ts`                      | Edit   | Import + register delegation tools; add `DelegationContentBuffer` to `ToolDependencies` |
| 6   | `src/index.ts` (or main entry)            | Edit   | Instantiate `DelegationContentBuffer`, pass into deps                                   |
| 7   | `tests/delegation-tool-handlers.test.ts`  | Create | Unit tests for all 6 tools                                                              |
| 8   | `tests/delegation-content-buffer.test.ts` | Create | Buffer unit tests                                                                       |

---

## 7. Constraints

- **SQ-14**: `description` and `result` are transient only. They appear in create/complete responses and WS push but are never in GET responses.
- **Flat params**: Request bodies go directly — NOT nested under a `"delegation"` key.
- **Limit clamping**: `list_delegations` must clamp `limit` to max 100, matching server behavior.
- **UUID validation**: All UUID parameters must be validated before sending to server (follow existing pattern — reject malformed UUIDs client-side).
- **Error mapping**: Use existing `MeshimizeAPIError` — 403, 404, 409, 422 all propagate naturally.

---

## 8. Validate

```bash
npm run build
npm run test
npm run format:check
npm run lint
```

---

## 9. Boundary Verification Block

> **Architecture contract section:** `docs/architecture/api-contracts/delegations.md` §4 (Endpoints) and §5 (JSON Rendering Module)
>
> **Server serializer:** `lib/meshimize_web/controllers/api/delegation_json.ex`
>
> **Interface spec (verbatim from contract):**
>
> - `POST /api/v1/delegations` — Request: `{ group_id, description, target_account_id?, ttl_seconds? }`. Response: `{ data: Delegation + description }` via `DelegationJSON.data_with_description/1`. Status 201.
> - `GET /api/v1/delegations` — Query: `group_id?, state?, role?, limit?, after?`. Response: `{ data: Delegation[], meta: PaginationMeta }` via `DelegationJSON.metadata/1`. Status 200.
> - `GET /api/v1/delegations/:id` — Response: `{ data: Delegation }` via `DelegationJSON.metadata/1`. Status 200.
> - `POST /api/v1/delegations/:id/accept` — No body. Response: `{ data: Delegation }` via `DelegationJSON.metadata/1`. Status 200.
> - `POST /api/v1/delegations/:id/complete` — Request: `{ result }`. Response: `{ data: Delegation + result }` via `DelegationJSON.data_with_result/1`. Status 200.
> - `POST /api/v1/delegations/:id/cancel` — No body. Response: `{ data: Delegation }` via `DelegationJSON.metadata/1`. Status 200.
>
> **Serializer cross-check (delegation_json.ex):**
>
> - `metadata/1` returns 16 fields: `id, state, group_id, group_name, sender_account_id, sender_display_name, target_account_id, target_display_name, assignee_account_id, assignee_display_name, expires_at, accepted_at, completed_at, cancelled_at, inserted_at, updated_at`. No content fields.
> - `data_with_description/1` returns `metadata/1` + `description` (from in-memory struct).
> - `data_with_result/1` returns `metadata/1` + `result` (from in-memory struct).
>
> **Key divergence risks:**
>
> - `description` and `result` are NOT in GET responses. MCP tools must not expect them from list/show.
> - `group_name` is a joined field (from `delegation.group.name`), always present — not nullable.
> - `target_display_name` and `assignee_display_name` use short-circuit `&&` — null when the FK is null.
> - Accept and cancel responses use `metadata/1` (no transient fields), not `show/1`.
> - Create returns 201, all other mutations return 200.
