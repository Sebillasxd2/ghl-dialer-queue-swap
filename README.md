# ghl-dialer-queue-swap

Swap a sales rep's GoHighLevel dialer queue for today's list, and prove the old queue is gone before loading the new one.

## The problem

Each rep dials from a queue: contacts that carry the rep's queue tag, which fires a workflow that puts them in the rep's call queue. Every morning yesterday's queue has to come out and today's list has to go in. Done naively, leftovers pile up, new leads silently never show, and the rep starts the shift with a queue that is empty or full of the wrong people.

## The traps nobody documents

Each one is reproduced by a test against the in-memory fake ([test/platform-traps.test.ts](test/platform-traps.test.ts)).

1. **Adding a tag the contact already has is a silent no-op.** The API answers success, nothing changes, and the "tag added" trigger never fires. A lead that still carried an old tag never reaches today's queue. Fix: remove the tag, then add it, so every add is a real event.
2. **Removing a tag does not take the contact out of the workflow.** A contact whose tag was removed by hand stays in the call queue as a ghost, and a search by tag will never find it again. Fix: also search by owner, and unenroll explicitly.
3. **Without `assignedTo` the rep's queue is empty.** A user restricted to their assigned data only sees contacts assigned to them. The contact is enrolled, the workflow ran, and the rep still sees nothing. Fix: upsert with `assignedTo` set to the rep's user id.
4. **The search index trails writes.** A contact tagged a moment ago may not be returned by `POST /contacts/search` yet, so one empty search does not prove an empty queue. Fix: keep looping until several searches in a row, spaced past the lag, come back empty. Verify the load with `GET /contacts/{id}`, which reads the record itself.
5. **Status codes are not outcomes.** The tests simulate a write that answers 200 and does not apply. The only thing that catches it is checking the resulting state, so both the wipe and the load end in a verification step.

## The solution

`swapQueue()` in [src/swap.ts](src/swap.ts) runs five steps, in this order:

1. **Plan** (pure, no API calls). Normalize phones to E.164, drop invalid and toll-free numbers, drop duplicate numbers, skip numbers dialed in the last N days (cool-off, default 7), order mobile first, cap at 250. If the plan is empty, stop: an empty plan must never blank yesterday's queue.
2. **Wipe.** Find the union of "has the queue tag" and "is assigned to the rep". For each contact: unenroll from the rep's workflow, remove the tag, release ownership. Contacts with a protected tag (`booked`, `customer`) leave the queue but keep their owner. Repeat with a settle delay until `confirmPasses` consecutive searches are empty.
3. **Gate.** If the wipe could not verify an empty queue within `maxPasses`, abort. Nothing gets loaded on top of leftovers.
4. **Load.** Upsert with `assignedTo`, then remove and re-add the queue tag. Tags never travel inside the upsert body, so the upsert cannot clobber tags other processes own.
5. **Verify.** Read every loaded contact back by id and report owner or tag mismatches.

Every API call goes through one retry policy: 429 and 5xx back off exponentially and honor `Retry-After`; any other 4xx fails that lead and the run moves on.

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
retries after 429/5xx: 9
after:  Avery Sample sees 12 contacts
other rep untouched: 1 contact(s)
```

### Against a real location

```sh
GHL_API_TOKEN=... GHL_LOCATION_ID=... node src/cli.ts swap --live --rep rep_demo_01 --leads my-leads.json --calls my-calls.json
```

This writes to a live CRM, so point it at a test location first. The token needs read and write access to contacts. The rep's workflow (trigger: contact tag added, on the rep's queue tag) is built in the GHL UI; this tool fills the queue, it does not build the workflow.

## Layout

| path | what |
|---|---|
| `src/plan.ts` | E.164, toll-free, duplicates, cool-off, mobile first, cap |
| `src/wipe.ts` | tag and owner union, settle loop, protected tags |
| `src/load.ts` | upsert with owner, remove then add, read-back verification |
| `src/swap.ts` | plan, wipe, gate, load, verify |
| `src/retry.ts` | backoff on 429 and 5xx |
| `src/ghl-http.ts` | the port over `services.leadconnectorhq.com` (API v2) |
| `src/fake-ghl.ts` | in-memory location with index lag, tag no-ops, faults and 429s |
| `fixtures/` | synthetic `reps`, `leads` and `calls`: invented companies, `+1555` numbers, `@example.com` emails |

## Known gaps

- **Clearing `assignedTo`.** The public docs type it as a string and do not say how to clear it. `releaseOwner` sends `null`; confirm on a test location before relying on it.
- **Unenrolling a contact that is not enrolled.** The response is not documented. The adapter treats 404 as already done.
- **Search filter shape.** `{ field: "tags", operator: "contains", value }` and `{ field: "assignedTo", operator: "eq", value }` follow the public Search Contacts docs as I read them. Check them against your account; the tests pin exactly these shapes.

---

*Pattern extracted from work I did on an outbound sales operation; the code here is written from scratch with synthetic data.*
