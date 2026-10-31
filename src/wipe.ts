import type { Clock } from "./clock.ts";
import type { GhlPort, SearchFilter } from "./ghl-port.ts";
import type { Invoke } from "./retry.ts";
import type { Contact, Rep } from "./types.ts";

export interface WipeOptions {
  /** Wait between passes. Should be longer than the search index lag. */
  settleMs: number;
  /** Consecutive empty searches required before the queue counts as empty. */
  confirmPasses: number;
  /** Give up (and report not verified) after this many passes. */
  maxPasses: number;
  /** Contacts carrying any of these tags leave the queue but keep their owner. */
  protectedTags: string[];
}

export const DEFAULT_WIPE: WipeOptions = {
  settleMs: 5_000,
  confirmPasses: 2,
  maxPasses: 12,
  protectedTags: ["booked", "customer"],
};

export interface WipeResult {
  verifiedEmpty: boolean;
  passes: number;
  /** Every contact the wipe took out of the queue, once each. */
  removed: string[];
  errors: { contactId: string; message: string }[];
}

/**
 * Empties a rep's queue and only reports success once the queue is verifiably empty.
 *
 * A contact can be in the queue two ways, so both are searched every pass:
 * - it carries the queue tag (the normal case);
 * - it is assigned to the rep but lost the tag, e.g. removed by hand. Removing a tag
 *   does not take a contact out of a workflow, so these ghosts stay in the call queue.
 *
 * The search index lags behind writes, so a single empty search proves nothing: a
 * contact tagged a moment ago may not be indexed yet. The loop keeps going until
 * `confirmPasses` searches in a row, `settleMs` apart, come back empty.
 */
export async function wipeQueue(
  ghl: GhlPort,
  rep: Rep,
  options: WipeOptions,
  ctx: { invoke: Invoke; clock: Clock },
): Promise<WipeResult> {
  const removed = new Set<string>();
  const errors: WipeResult["errors"] = [];
  // Protected contacts never leave the owner search, so they count as clean once handled.
  const handledProtected = new Set<string>();
  let emptyStreak = 0;

  for (let pass = 1; pass <= options.maxPasses; pass++) {
    let found: Contact[];
    try {
      found = await findQueueMembers(ghl, rep, ctx.invoke);
    } catch (err) {
      // Without a search there is no way to prove the queue empty.
      errors.push({ contactId: "(search)", message: (err as Error).message });
      return { verifiedEmpty: false, passes: pass, removed: [...removed], errors };
    }
    const pending = found.filter((contact) => {
      const isProtected = contact.tags.some((tag) => options.protectedTags.includes(tag));
      return contact.tags.includes(rep.queueTag) || !isProtected || !handledProtected.has(contact.id);
    });

    if (pending.length === 0) {
      emptyStreak++;
      if (emptyStreak >= options.confirmPasses) {
        return { verifiedEmpty: true, passes: pass, removed: [...removed], errors };
      }
    } else {
      emptyStreak = 0;
      for (const contact of pending) {
        const isProtected = contact.tags.some((tag) => options.protectedTags.includes(tag));
        try {
          await ctx.invoke(() => ghl.removeFromWorkflow(contact.id, rep.workflowId));
          if (contact.tags.includes(rep.queueTag)) {
            await ctx.invoke(() => ghl.removeTag(contact.id, rep.queueTag));
          }
          if (isProtected) handledProtected.add(contact.id);
          else await ctx.invoke(() => ghl.releaseOwner(contact.id));
          removed.add(contact.id);
        } catch (err) {
          errors.push({ contactId: contact.id, message: (err as Error).message });
        }
      }
    }

    if (pass < options.maxPasses) await ctx.clock.sleep(options.settleMs);
  }

  return { verifiedEmpty: false, passes: options.maxPasses, removed: [...removed], errors };
}

/**
 * Union of "has the queue tag" and "is assigned to the rep", deduplicated by id.
 * Follows the cursor until a page is empty or has none: a short page is not
 * necessarily the last one.
 */
async function findQueueMembers(ghl: GhlPort, rep: Rep, invoke: Invoke): Promise<Contact[]> {
  const byId = new Map<string, Contact>();
  for (const filter of [{ tag: rep.queueTag }, { assignedTo: rep.ghlUserId }] satisfies SearchFilter[]) {
    let cursor: unknown[] | undefined;
    let previous = "";
    for (;;) {
      const page = await invoke(() => ghl.searchContacts(filter, cursor));
      for (const contact of page.contacts) byId.set(contact.id, contact);
      if (!page.contacts.length || !page.next) break;
      const key = JSON.stringify(page.next);
      if (key === previous) throw new Error(`search cursor did not advance: ${key}`);
      previous = key;
      cursor = page.next;
    }
  }
  return [...byId.values()];
}
