import type { Policy, PolicyAction } from "./types.ts"

/**
 * Policy table (ADR-C05 core module) — runtime-agnostic. Identical for the
 * OpenCode and Claude Code adapters: which Nexus MCP tools get compressed,
 * passed through, or skipped, and at what token threshold.
 */
export const POLICIES: Record<string, Policy> = {
  // ── Layer 1: Knowledge Access ─────────────────────────────────────────────
  nexus_kb_memory: { action: "compress", profile: "reference-data", minTokens: 2000 },
  nexus_kb_search: { action: "compress", profile: "search-results", minTokens: 800 },
  nexus_kb_get: { action: "compress", profile: "reference-data", minTokens: 3000 },
  nexus_kb_related: { action: "compress", profile: "structured-list", minTokens: 3000 },
  nexus_project_list: { action: "compress", profile: "structured-list", minTokens: 2000 },

  // ── Layer 2: Coordination — list/read tools ───────────────────────────────
  nexus_dispatch_sweep: { action: "compress", profile: "structured-list", minTokens: 500 },
  nexus_dispatch_inbox: { action: "compress", profile: "structured-list", minTokens: 2000 },
  nexus_dispatch_outbox: { action: "compress", profile: "structured-list", minTokens: 2000 },
  nexus_dispatch_get: { action: "compress", profile: "reference-data", minTokens: 3000 },
  nexus_dispatch_related: { action: "compress", profile: "structured-list", minTokens: 2000 },
  nexus_doc_list: { action: "compress", profile: "structured-list", minTokens: 2000 },
  nexus_task_list: { action: "compress", profile: "structured-list", minTokens: 2000 },
  nexus_dc_list: { action: "compress", profile: "structured-list", minTokens: 2000 },

  nexus_session_list: { action: "passthrough", reason: "small-response" },

  // ── Layer 2: Write operations — never compress ────────────────────────────
  nexus_session_create: { action: "passthrough", reason: "write-operation" },
  nexus_session_append: { action: "passthrough", reason: "write-operation" },
  nexus_session_close: { action: "passthrough", reason: "write-operation" },

  nexus_task_create: { action: "passthrough", reason: "write-operation" },
  nexus_task_update: { action: "passthrough", reason: "write-operation" },
  nexus_task_note: { action: "passthrough", reason: "write-operation" },
  nexus_task_delete: { action: "passthrough", reason: "write-operation" },

  nexus_doc_ingest: { action: "passthrough", reason: "write-operation" },
  nexus_doc_classify: { action: "passthrough", reason: "write-operation" },
  nexus_doc_update: { action: "passthrough", reason: "write-operation" },
  nexus_doc_delete: { action: "passthrough", reason: "write-operation" },

  nexus_dispatch_create: { action: "passthrough", reason: "write-operation" },
  nexus_dispatch_reply: { action: "passthrough", reason: "write-operation" },
  nexus_dispatch_resolve: { action: "passthrough", reason: "write-operation" },
  nexus_dispatch_close: { action: "passthrough", reason: "write-operation" },
  nexus_dispatch_ack: { action: "passthrough", reason: "write-operation" },
  nexus_dispatch_assign: { action: "passthrough", reason: "write-operation" },
  nexus_dispatch_forward: { action: "passthrough", reason: "write-operation" },

  nexus_dc_add: { action: "passthrough", reason: "write-operation" },

  nexus_adr_create: { action: "passthrough", reason: "write-operation" },
  nexus_adr_submit: { action: "passthrough", reason: "write-operation" },
  nexus_adr_decide: { action: "passthrough", reason: "write-operation" },

  // ── Layer 2: Legacy vl_ aliases (vault letter API) ────────────────────────
  nexus_vl_inbox: { action: "compress", profile: "structured-list", minTokens: 2000 },
  nexus_vl_outbox: { action: "compress", profile: "structured-list", minTokens: 2000 },
  nexus_vl_create: { action: "passthrough", reason: "write-operation" },
  nexus_vl_reply: { action: "passthrough", reason: "write-operation" },
  nexus_vl_ack: { action: "passthrough", reason: "write-operation" },

  // ── Skills (sk_*) ─────────────────────────────────────────────────────────
  nexus_sk_list: { action: "compress", profile: "structured-list", minTokens: 2000 },
  nexus_sk_get: { action: "compress", profile: "reference-data", minTokens: 2000 },
  nexus_sk_export: { action: "compress", profile: "structured-list", minTokens: 2000 },
  nexus_sk_create: { action: "passthrough", reason: "write-operation" },
  nexus_sk_update: { action: "passthrough", reason: "write-operation" },
  nexus_sk_activate: { action: "passthrough", reason: "write-operation" },
  nexus_sk_assign: { action: "passthrough", reason: "write-operation" },
  nexus_sk_unassign: { action: "passthrough", reason: "write-operation" },

  // ── Directives (pd_*) ─────────────────────────────────────────────────────
  nexus_pd_list: { action: "compress", profile: "structured-list", minTokens: 2000 },
  nexus_directive_export: { action: "compress", profile: "structured-list", minTokens: 2000 },
  nexus_pd_get: { action: "compress", profile: "reference-data", minTokens: 2000 },
  nexus_pd_create: { action: "passthrough", reason: "write-operation" },
  nexus_pd_update: { action: "passthrough", reason: "write-operation" },
  nexus_pd_delete: { action: "passthrough", reason: "write-operation" },
  nexus_pd_toggle: { action: "passthrough", reason: "write-operation" },

  // ── Reviews (rv_*) ────────────────────────────────────────────────────────
  nexus_rv_list: { action: "compress", profile: "structured-list", minTokens: 2000 },
  nexus_rv_get: { action: "compress", profile: "reference-data", minTokens: 2000 },
  nexus_rv_create: { action: "passthrough", reason: "write-operation" },
  nexus_rv_decide: { action: "passthrough", reason: "write-operation" },
  nexus_rv_comment: { action: "passthrough", reason: "write-operation" },

  // ── Retrieval — never compress, must be passed through verbatim ───────────
  nexus_headroom_retrieve: { action: "passthrough", reason: "explicit-detail-request" },
  headroom_retrieve: { action: "passthrough", reason: "explicit-detail-request" },
  headroom_headroom_retrieve: { action: "passthrough", reason: "explicit-detail-request" },
  nexus_headroom_intercept_retrieve: { action: "passthrough", reason: "plugin-retrieval-tool" },

  // ── Shell — handled by RTK ────────────────────────────────────────────────
  bash: { action: "skip", reason: "handled-by-rtk" },
  shell: { action: "skip", reason: "handled-by-rtk" },

  // ── Active editing context — never compress ───────────────────────────────
  read: { action: "skip", reason: "active-editing-context" },
  write: { action: "skip", reason: "active-editing-context" },
  edit: { action: "skip", reason: "active-editing-context" },
  glob: { action: "skip", reason: "file-search" },
  grep: { action: "skip", reason: "code-search" },
}

export const DEFAULT_MIN_TOKENS = 2000

export interface PolicyLookupResult {
  policy: Policy | null
  /** true when this tool has no explicit policy and should be treated as a no-op skip. */
  noMatch: boolean
}

/** Policy lookup: exact match, then nexus_ or headroom_ prefix fallback. */
export function lookupPolicy(toolName: string): PolicyLookupResult {
  const exact = POLICIES[toolName]
  if (exact) return { policy: exact, noMatch: false }

  if (toolName.startsWith("nexus_") || toolName.startsWith("headroom_")) {
    return {
      policy: { action: "passthrough" as PolicyAction, reason: "no-explicit-policy" },
      noMatch: false,
    }
  }

  return { policy: null, noMatch: true }
}
