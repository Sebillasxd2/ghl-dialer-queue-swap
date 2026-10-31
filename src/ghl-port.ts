import type { Contact, UpsertInput } from "./types.ts";

export type SearchFilter = { tag: string } | { assignedTo: string };

export interface ContactPage {
  contacts: Contact[];
  /** Cursor for the next page (GHL's `searchAfter`), absent on the last page. */
  next?: unknown[];
}

/**
 * The handful of GHL operations a queue swap needs. `ghl-http.ts` implements it
 * against the public API; `fake-ghl.ts` implements it in memory for tests and the demo.
 */
export interface GhlPort {
  /** Backed by the search index, which lags behind writes. */
  searchContacts(filter: SearchFilter, searchAfter?: unknown[]): Promise<ContactPage>;
  /** Reads the contact record itself, so it reflects writes immediately. */
  getContact(contactId: string): Promise<Contact>;
  upsertContact(input: UpsertInput): Promise<{ id: string; created: boolean }>;
  addTag(contactId: string, tag: string): Promise<void>;
  removeTag(contactId: string, tag: string): Promise<void>;
  removeFromWorkflow(contactId: string, workflowId: string): Promise<void>;
  releaseOwner(contactId: string): Promise<void>;
}

export class GhlHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "GhlHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}
