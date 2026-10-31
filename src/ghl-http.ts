import { GhlHttpError, type ContactPage, type GhlPort, type SearchFilter } from "./ghl-port.ts";
import type { Contact, UpsertInput } from "./types.ts";

export const GHL_BASE_URL = "https://services.leadconnectorhq.com";
export const GHL_API_VERSION = "2021-07-28";

export interface HttpPortOptions {
  token: string;
  locationId: string;
  baseUrl?: string;
  version?: string;
  pageLimit?: number;
  fetch?: typeof fetch;
}

/**
 * `GhlPort` over the public GHL API v2. Deliberately thin: no retries here, the swap
 * wraps every call in its own retry policy so the fake and the real API behave alike.
 */
export function createHttpPort(options: HttpPortOptions): GhlPort {
  const baseUrl = options.baseUrl ?? GHL_BASE_URL;
  const doFetch = options.fetch ?? fetch;
  const pageLimit = options.pageLimit ?? 100;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${options.token}`,
        Version: options.version ?? GHL_API_VERSION,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new GhlHttpError(
        response.status,
        `${method} ${path} -> ${response.status} ${text.slice(0, 200)}`,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  return {
    async searchContacts(filter: SearchFilter, searchAfter?: unknown[]): Promise<ContactPage> {
      const condition =
        "tag" in filter
          ? { field: "tags", operator: "contains", value: filter.tag }
          : { field: "assignedTo", operator: "eq", value: filter.assignedTo };
      const res = await request<{ contacts?: (Contact & { searchAfter?: unknown[] })[] }>(
        "POST",
        "/contacts/search",
        {
          locationId: options.locationId,
          pageLimit,
          filters: [condition],
          ...(searchAfter ? { searchAfter } : {}),
        },
      );
      const contacts = (res.contacts ?? []).map(({ searchAfter: _cursor, ...contact }) => ({
        ...contact,
        tags: contact.tags ?? [],
      }));
      const last = res.contacts?.at(-1);
      return contacts.length === pageLimit && last?.searchAfter ? { contacts, next: last.searchAfter } : { contacts };
    },

    async getContact(contactId) {
      const res = await request<{ contact: Contact }>("GET", `/contacts/${encodeURIComponent(contactId)}`);
      return { ...res.contact, tags: res.contact.tags ?? [] };
    },

    async upsertContact(input: UpsertInput) {
      const res = await request<{ new?: boolean; contact: { id: string } }>("POST", "/contacts/upsert", {
        locationId: options.locationId,
        ...input,
      });
      return { id: res.contact.id, created: res.new === true };
    },

    async addTag(contactId, tag) {
      await request("POST", `/contacts/${encodeURIComponent(contactId)}/tags`, { tags: [tag] });
    },

    async removeTag(contactId, tag) {
      await request("DELETE", `/contacts/${encodeURIComponent(contactId)}/tags`, { tags: [tag] });
    },

    async removeFromWorkflow(contactId, workflowId) {
      try {
        await request(
          "DELETE",
          `/contacts/${encodeURIComponent(contactId)}/workflow/${encodeURIComponent(workflowId)}`,
        );
      } catch (err) {
        // TODO(verify): the public docs do not say what unenrolling a contact that is not
        // enrolled returns. Treating 404 as "already out" keeps the wipe idempotent.
        if (err instanceof GhlHttpError && err.status === 404) return;
        throw err;
      }
    },

    async releaseOwner(contactId) {
      // TODO(verify): the docs list `assignedTo` as a string and do not say how to clear
      // it. `null` is what this sends; confirm against a test location before relying on it.
      await request("PUT", `/contacts/${encodeURIComponent(contactId)}`, { assignedTo: null });
    },
  };
}

/** `Retry-After` is either delta-seconds or an HTTP date. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
