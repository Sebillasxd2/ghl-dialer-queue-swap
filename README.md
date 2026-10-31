# ghl-dialer-queue-swap

Swap a sales rep's GoHighLevel dialer queue for today's list, and prove the old queue is gone before loading the new one.

## The problem

Each rep dials from a queue: contacts that carry the rep's queue tag, which fires a workflow that puts them in the rep's call queue. Every morning yesterday's queue has to come out and today's list has to go in. Done naively, leftovers pile up, new leads silently never show, and the rep starts the shift with a queue that is empty or full of the wrong people.

## The traps nobody documents

Each one is reproduced by a test against the in-memory fake: traps 1 to 4 in [test/platform-traps.test.ts](test/platform-traps.test.ts), trap 5 in [test/load.test.ts](test/load.test.ts) and [test/swap.test.ts](test/swap.test.ts).

1. **Adding a tag the contact already has is a silent no-op.** The API answers success, nothing changes, and the "tag added" trigger never fires. A lead that still carried an old tag never reaches today's queue. Fix: remove the tag, then add it, so every add is a real event.
2. **Removing a tag does not take the contact out of the workflow.** A contact whose tag was removed by hand stays in the call queue as a ghost, and a search by tag will never find it again. Fix: also search by owner, and unenroll explicitly.
3. **Without `assignedTo` the rep's queue is empty.** A user restricted to their assigned data only sees contacts assigned to them. The contact is enrolled, the workflow ran, and the rep still sees nothing. Fix: upsert with `assignedTo` set to the rep's user id.
4. **The search index trails writes.** A contact tagged a moment ago may not be returned by `POST /contacts/search` yet, so one empty search does not prove an empty queue. Fix: keep looping, with a settle delay longer than the lag, until several passes in a row find nothing left to remove. Verify the load with `GET /contacts/{id}`, which reads the record itself.
5. **Status codes are not outcomes.** The tests simulate a write that answers 200 and does not apply. The only thing that catches it is checking the resulting state, so both the wipe and the load end in a verification step.

## The solution

`swapQueue()` in [src/swap.ts](src/swap.ts) runs five steps, in this order:

1. **Plan** (pure, no API calls). Normalize phones to E.164, drop invalid and toll-free numbers, keep one lead per number (the best line type, then the lowest lead id, whatever order the rows came in), skip numbers dialed in the last N days (cool-off, default 7), order mobile first, cap at 250. If the plan is empty, stop: an empty plan must never blank yesterday's queue.
2. **Wipe.** Find the union of "has the queue tag" and "is assigned to the rep". For each contact: unenroll from the rep's workflow, remove the tag, release ownership. Contacts with a protected tag (`booked`, `customer`) leave the queue but keep their owner. Whether a contact is protected is decided from the record itself (`GET /contacts/{id}`), not from the search result, so a tag applied inside the index lag still protects it. Repeat with a settle delay until `confirmPasses` consecutive passes find nothing left to remove (protected contacts keep their owner, so they stay in the owner search; they count as done once they are out of the workflow and untagged). A search that fails ends the wipe as not verified.
3. **Gate.** If the wipe could not verify an empty queue within `maxPasses`, abort. Nothing gets loaded on top of leftovers.
4. **Load.** Upsert with `assignedTo`, then remove the queue tag, read the contact back to confirm it is gone, and add it again. If the removal did not stick, the add would be a silent no-op, so that lead fails instead. Tags never travel inside the upsert body, so the upsert cannot clobber tags other processes own.
5. **Verify.** Read every loaded contact back by id and report owner or tag mismatches, or a read that failed.

A run in which nothing landed is reported as `aborted` with reason `load_failed`, not `loaded`: by then the old queue is gone, which is the outcome this whole tool exists to prevent. The CLI exits 0 only when every planned lead landed and read back correctly, so a scheduler sees anything less as a failure.

Every API call goes through one retry policy: 429 and 5xx back off exponentially, capped at `maxMs`, and honor `Retry-After`; a `Retry-After` longer than `maxMs` is not slept or retried early, the call fails at once with the server's value. Any other 4xx fails that one contact (in the wipe) or lead (in the load) and the run moves on; a failed search stops the wipe, and a failed read-back is a verification mismatch. None of them escape as an exception: the report always comes back.

## Run it

Needs Node 22.18 or newer, which runs TypeScript directly. No build step and no runtime dependencies.

```sh
npm test          # the whole suite, offline, no token
npm run demo      # a full swap against an in-memory location seeded with a leaky queue
npm run plan      # what today's queue would be, from fixtures/
```

`npm install` is only needed for `npm run typecheck`.

The demo seeds yesterday's queue with tagged contacts, a ghost, a contact the index has not caught up with, a booked contact and another rep's contact, and rate limits every ninth request:

```
before: Avery Sample sees 7 contacts
status: loaded
plan:   12 selected, skipped { toll_free: 2, invalid_phone: 1, duplicate_phone: 1, cool_off: 2 }
wipe:   7 removed in 4 passes, verified empty: true, errors: 0
load:   12 loaded, 0 failed
verify: ok
retries after 429/5xx: 11
after:  Avery Sample sees 12 contacts
other rep untouched: 1 contact(s)
```

### Against a real location

```sh
GHL_API_TOKEN=... GHL_LOCATION_ID=... node src/cli.ts swap --live --reps my-reps.json --rep rep_01 --leads my-leads.json --calls my-calls.json
```

`--reps` is required here: the rep record has to carry the account's real `ghlUserId`, `queueTag` and `workflowId` (same shape as [fixtures/reps.json](fixtures/reps.json)); without it the defaults are the synthetic fixtures. A bad `--now`, `--cap` or `--cool-off-days` stops the run with exit 2. This writes to a live CRM, so point it at a test location first. The token needs read and write access to contacts. The rep's workflow (trigger: contact tag added, on the rep's queue tag) is built in the GHL UI; this tool fills the queue, it does not build the workflow.

## Layout

| path | what |
|---|---|
| `src/plan.ts` | E.164, toll-free, one lead per number, cool-off, mobile first, cap |
| `src/wipe.ts` | tag and owner union, settle loop, protected tags |
| `src/load.ts` | upsert with owner, remove then add, read-back verification |
| `src/swap.ts` | plan, wipe, gate, load, verify |
| `src/retry.ts` | backoff on 429 and 5xx |
| `src/ghl-http.ts` | the port over `services.leadconnectorhq.com` (API v2) |
| `src/fake-ghl.ts` | in-memory location with index lag, tag no-ops, faults and 429s |
| `fixtures/` | synthetic `reps`, `leads` and `calls`: invented companies, `+1555` numbers, `@example.com` emails |

## Known gaps

- **Verification proves owner and tag, not that the workflow fired.** The public API used here does not expose workflow enrollment. Today the trigger is guarded by the read between removing and re-adding the tag. To confirm on a test location: that the call task actually appears for the rep.
- **Clearing `assignedTo`.** The public docs type it as a string and do not say how to clear it. Today `releaseOwner` sends `null`. To confirm on a test location before relying on it.
- **Unenrolling a contact that is not enrolled.** The response is not documented. Today the adapter treats 404 as already done. To confirm: what the API actually returns.
- **Search filter shape.** Today the adapter sends `{ field: "tags", operator: "contains", value }` and `{ field: "assignedTo", operator: "eq", value }`, as I read the public Search Contacts docs, and the tests pin exactly these shapes. To confirm against your account.

---

*Pattern extracted from work I did on an outbound sales operation; the code here is written from scratch with synthetic data.*
