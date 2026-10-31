import type { Clock } from "./clock.ts";
import { GhlHttpError, type ContactPage, type GhlPort, type SearchFilter } from "./ghl-port.ts";
import type { Contact, UpsertInput } from "./types.ts";

export type FakeOp = keyof GhlPort;

/** Make an operation fail. `silent` returns success without applying the write. */
export interface Fault {
  op: FakeOp;
  contactId?: string;
  status?: number;
  times?: number;
  silent?: boolean;
}

export interface FakeGhlOptions {
  clock: Clock;
  /** How long a write takes to show up in search results. */
  indexLagMs?: number;
  pageSize?: number;
  /** Workflows with a "tag added" trigger: tag name to workflow id. */
  triggers?: Record<string, string>;
  /** Every Nth request answers 429 with `Retry-After: 1`. */
  rateLimitEvery?: number;
  faults?: Fault[];
}

interface Snapshot {
  at: number;
  state: Contact;
}

/**
 * In-memory GHL location that reproduces the behaviors a queue swap has to survive:
 * - adding a tag the contact already has changes nothing and fires no trigger;
 * - removing a tag does not take the contact out of a workflow;
 * - search reads an index that trails writes by `indexLagMs`;
 * - a restricted user's queue only shows contacts assigned to that user;
 * - 429s and failing or silently ignored writes, on demand.
 */
export class FakeGhl implements GhlPort {
  readonly log: { op: FakeOp; contactId?: string }[] = [];
  private readonly contacts = new Map<string, Contact>();
  private readonly history = new Map<string, Snapshot[]>();
  private readonly enrollments = new Map<string, Set<string>>();
  private readonly faults: Fault[];
  private readonly clock: Clock;
  private readonly indexLagMs: number;
  private readonly pageSize: number;
  private readonly triggers: Record<string, string>;
  private readonly rateLimitEvery: number;
  private requests = 0;
  private nextId = 1;

  constructor(options: FakeGhlOptions) {
    this.clock = options.clock;
    this.indexLagMs = options.indexLagMs ?? 0;
    this.pageSize = options.pageSize ?? 100;
    this.triggers = options.triggers ?? {};
    this.rateLimitEvery = options.rateLimitEvery ?? 0;
    this.faults = (options.faults ?? []).map((fault) => ({ ...fault }));
  }

  /**
   * Adds a pre-existing contact. By default it is already indexed; `justWritten`
   * makes it invisible to search until the index catches up.
   */
  seed(
    contact: Partial<Contact> & { phone: string },
    options: { enrolledIn?: string[]; justWritten?: boolean } = {},
  ): Contact {
    const id = contact.id ?? this.newId();
    const state: Contact = { tags: [], assignedTo: null, ...contact, id };
    this.contacts.set(id, state);
    const at = options.justWritten ? this.clock.now() : this.clock.now() - this.indexLagMs;
    this.history.set(id, [{ at, state: structuredClone(state) }]);
    for (const workflowId of options.enrolledIn ?? []) this.enroll(workflowId, id);
    return structuredClone(state);
  }

  /** What a restricted user sees in the call queue of a workflow. */
  visibleQueue(userId: string, workflowId: string): Contact[] {
    return this.enrolledIn(workflowId)
      .map((id) => this.contacts.get(id))
      .filter((contact): contact is Contact => contact?.assignedTo === userId)
      .map((contact) => structuredClone(contact));
  }

  enrolledIn(workflowId: string): string[] {
    return [...(this.enrollments.get(workflowId) ?? [])].sort();
  }

  peek(contactId: string): Contact | undefined {
    const contact = this.contacts.get(contactId);
    return contact && structuredClone(contact);
  }

  count(op: FakeOp): number {
    return this.log.filter((entry) => entry.op === op).length;
  }

  async searchContacts(filter: SearchFilter, searchAfter?: unknown[]): Promise<ContactPage> {
    this.gate("searchContacts");
    const cutoff = this.clock.now() - this.indexLagMs;
    const after = typeof searchAfter?.[0] === "string" ? searchAfter[0] : "";
    const matches: Contact[] = [];
    // One ordering for both the sort and the cursor: plain code-unit comparison.
    for (const [id, snapshots] of [...this.history].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (after && id <= after) continue;
      const indexed = snapshots.filter((snap) => snap.at <= cutoff).at(-1)?.state;
      if (!indexed) continue;
      const hit = "tag" in filter ? indexed.tags.includes(filter.tag) : indexed.assignedTo === filter.assignedTo;
      if (hit) matches.push(structuredClone(indexed));
    }
    const contacts = matches.slice(0, this.pageSize);
    const last = contacts.at(-1);
    return matches.length > this.pageSize && last ? { contacts, next: [last.id] } : { contacts };
  }

  async getContact(contactId: string): Promise<Contact> {
    this.gate("getContact", contactId);
    return structuredClone(this.mustGet(contactId));
  }

  async upsertContact(input: UpsertInput): Promise<{ id: string; created: boolean }> {
    this.gate("upsertContact"); // `silent` is not meaningful here: there is no id to return.
    const existing = [...this.contacts.values()].find((contact) => contact.phone === input.phone);
    const { source: _source, ...fields } = input;
    if (existing) {
      this.write(existing.id, { ...existing, ...definedOnly(fields) });
      return { id: existing.id, created: false };
    }
    const id = this.newId();
    this.write(id, { id, tags: [], ...definedOnly(fields) });
    return { id, created: true };
  }

  async addTag(contactId: string, tag: string): Promise<void> {
    if (this.gate("addTag", contactId)) return;
    const contact = this.mustGet(contactId);
    if (contact.tags.includes(tag)) return; // The trap: no change, no event, no error.
    this.write(contactId, { ...contact, tags: [...contact.tags, tag] });
    const workflowId = this.triggers[tag];
    if (workflowId) this.enroll(workflowId, contactId);
  }

  async removeTag(contactId: string, tag: string): Promise<void> {
    if (this.gate("removeTag", contactId)) return;
    const contact = this.mustGet(contactId);
    // Workflow enrollment is deliberately left alone.
    this.write(contactId, { ...contact, tags: contact.tags.filter((t) => t !== tag) });
  }

  async removeFromWorkflow(contactId: string, workflowId: string): Promise<void> {
    if (this.gate("removeFromWorkflow", contactId)) return;
    this.mustGet(contactId);
    this.enrollments.get(workflowId)?.delete(contactId);
  }

  async releaseOwner(contactId: string): Promise<void> {
    if (this.gate("releaseOwner", contactId)) return;
    const contact = this.mustGet(contactId);
    this.write(contactId, { ...contact, assignedTo: null });
  }

  /** Logs the request, applies rate limiting and faults. Returns true for a silent no-op. */
  private gate(op: FakeOp, contactId?: string): boolean {
    this.log.push(contactId ? { op, contactId } : { op });
    this.requests++;
    if (this.rateLimitEvery > 0 && this.requests % this.rateLimitEvery === 0) {
      throw new GhlHttpError(429, "Too Many Requests", 1_000);
    }
    const fault = this.faults.find(
      (f) => f.op === op && (f.contactId === undefined || f.contactId === contactId) && (f.times ?? Infinity) > 0,
    );
    if (!fault) return false;
    if (fault.times !== undefined) fault.times--;
    if (fault.silent) return true;
    throw new GhlHttpError(fault.status ?? 500, `injected failure on ${op}`);
  }

  private write(id: string, state: Contact): void {
    this.contacts.set(id, state);
    const snapshots = this.history.get(id) ?? [];
    snapshots.push({ at: this.clock.now(), state: structuredClone(state) });
    this.history.set(id, snapshots);
  }

  private enroll(workflowId: string, contactId: string): void {
    const set = this.enrollments.get(workflowId) ?? new Set<string>();
    set.add(contactId);
    this.enrollments.set(workflowId, set);
  }

  private mustGet(contactId: string): Contact {
    const contact = this.contacts.get(contactId);
    if (!contact) throw new GhlHttpError(404, `contact ${contactId} not found`);
    return contact;
  }

  private newId(): string {
    return `ct_demo_${String(this.nextId++).padStart(4, "0")}`;
  }
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
