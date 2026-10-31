import type { GhlPort } from "./ghl-port.ts";
import type { PlannedLead } from "./plan.ts";
import type { Invoke } from "./retry.ts";
import type { Rep } from "./types.ts";

export interface LoadResult {
  loaded: { leadId: string; contactId: string; created: boolean }[];
  failed: { leadId: string; message: string }[];
}

export interface VerifyResult {
  ok: boolean;
  mismatches: { contactId: string; problem: "not_assigned" | "missing_tag" }[];
}

/**
 * Puts each planned lead into the rep's queue:
 * 1. Upsert with `assignedTo` set. A restricted user only sees contacts assigned to
 *    them, so a queued contact without an owner is invisible to the rep.
 * 2. Remove the queue tag, then add it. Adding a tag the contact already has is a
 *    silent no-op: nothing errors, but the "tag added" trigger never fires and the
 *    contact never reaches the call queue. Removing first makes every add a real event.
 *
 * Tags are never sent inside the upsert body, so the upsert cannot clobber tags that
 * other processes own.
 */
export async function loadQueue(
  ghl: GhlPort,
  rep: Rep,
  leads: PlannedLead[],
  ctx: { invoke: Invoke; source: string },
): Promise<LoadResult> {
  const result: LoadResult = { loaded: [], failed: [] };

  for (const lead of leads) {
    try {
      const { id, created } = await ctx.invoke(() =>
        ghl.upsertContact({
          phone: lead.phone,
          firstName: lead.firstName,
          lastName: lead.lastName,
          email: lead.email,
          companyName: lead.company,
          assignedTo: rep.ghlUserId,
          source: ctx.source,
        }),
      );
      await ctx.invoke(() => ghl.removeTag(id, rep.queueTag));
      await ctx.invoke(() => ghl.addTag(id, rep.queueTag));
      result.loaded.push({ leadId: lead.id, contactId: id, created });
    } catch (err) {
      result.failed.push({ leadId: lead.id, message: (err as Error).message });
    }
  }

  return result;
}

/**
 * Reads every loaded contact back by id. Uses `getContact`, not search: the search
 * index lags, so a search right after the load would report stale state.
 */
export async function verifyLoad(
  ghl: GhlPort,
  rep: Rep,
  contactIds: string[],
  ctx: { invoke: Invoke },
): Promise<VerifyResult> {
  const mismatches: VerifyResult["mismatches"] = [];
  for (const contactId of contactIds) {
    const contact = await ctx.invoke(() => ghl.getContact(contactId));
    if (contact.assignedTo !== rep.ghlUserId) mismatches.push({ contactId, problem: "not_assigned" });
    if (!contact.tags.includes(rep.queueTag)) mismatches.push({ contactId, problem: "missing_tag" });
  }
  return { ok: mismatches.length === 0, mismatches };
}
