// The HTTP adapter against a recording fetch: request shapes only, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttpPort, parseRetryAfter } from "../src/ghl-http.ts";
import { GhlHttpError } from "../src/ghl-port.ts";

interface Recorded {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

function recordingFetch(respond: (req: Recorded) => Response) {
  const requests: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req: Recorded = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: Object.fromEntries(Object.entries(init?.headers ?? {})),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    requests.push(req);
    return respond(req);
  }) as typeof fetch;
  return { requests, fetchImpl };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

test("sends the bearer token and the Version header to the public API host", async () => {
  const { requests, fetchImpl } = recordingFetch(() => json({ contact: { id: "ct_1", tags: [] } }));
  const port = createHttpPort({ token: "demo-token", locationId: "loc_demo_0001", fetch: fetchImpl });

  await port.getContact("ct_1");

  const [req] = requests;
  assert.equal(req?.url.origin, "https://services.leadconnectorhq.com");
  assert.equal(req?.url.pathname, "/contacts/ct_1");
  assert.equal(req?.headers.Authorization, "Bearer demo-token");
  assert.equal(req?.headers.Version, "2021-07-28");
});

test("searches by tag and follows the searchAfter cursor of the last contact", async () => {
  const { requests, fetchImpl } = recordingFetch(() =>
    json({
      contacts: [
        { id: "a", tags: ["q"], searchAfter: [1, "a"] },
        { id: "b", tags: ["q"], searchAfter: [2, "b"] },
      ],
    }),
  );
  const port = createHttpPort({ token: "t", locationId: "loc_demo_0001", pageLimit: 2, fetch: fetchImpl });

  const first = await port.searchContacts({ tag: "q" });
  await port.searchContacts({ tag: "q" }, first.next);

  assert.deepEqual(requests[0]?.body, {
    locationId: "loc_demo_0001",
    pageLimit: 2,
    filters: [{ field: "tags", operator: "contains", value: "q" }],
  });
  assert.deepEqual(first.next, [2, "b"]);
  assert.deepEqual((requests[1]?.body as { searchAfter: unknown }).searchAfter, [2, "b"]);
  assert.equal("searchAfter" in first.contacts[0]!, false, "cursor is not leaked into contacts");
});

test("searches by owner; a short page still hands back its cursor", async () => {
  const { requests, fetchImpl } = recordingFetch(() => json({ contacts: [{ id: "a", searchAfter: [1, "a"] }] }));
  const port = createHttpPort({ token: "t", locationId: "loc_demo_0001", pageLimit: 100, fetch: fetchImpl });
  const page = await port.searchContacts({ assignedTo: "usr_demo_0001" });
  assert.deepEqual((requests[0]?.body as { filters: unknown }).filters, [
    { field: "assignedTo", operator: "eq", value: "usr_demo_0001" },
  ]);
  assert.deepEqual(page.next, [1, "a"], "asked for 100, got 1: the server may cap pages, so the cursor decides");
  assert.deepEqual(page.contacts[0]?.tags, [], "missing tags normalize to an empty list");
});

test("an empty page has no cursor", async () => {
  const { fetchImpl } = recordingFetch(() => json({ contacts: [] }));
  const port = createHttpPort({ token: "t", locationId: "loc_demo_0001", fetch: fetchImpl });
  assert.equal((await port.searchContacts({ tag: "q" })).next, undefined);
});

test("tag writes use the tag endpoints, never the contact body", async () => {
  const { requests, fetchImpl } = recordingFetch(() => json({ tags: [] }));
  const port = createHttpPort({ token: "t", locationId: "loc_demo_0001", fetch: fetchImpl });

  await port.removeTag("ct_1", "dialer-queue-avery");
  await port.addTag("ct_1", "dialer-queue-avery");

  assert.deepEqual(
    requests.map((r) => [r.method, r.url.pathname, r.body]),
    [
      ["DELETE", "/contacts/ct_1/tags", { tags: ["dialer-queue-avery"] }],
      ["POST", "/contacts/ct_1/tags", { tags: ["dialer-queue-avery"] }],
    ],
  );
});

test("upsert sends the location and the owner, and reports whether it created", async () => {
  const { requests, fetchImpl } = recordingFetch(() => json({ new: true, contact: { id: "ct_9" } }));
  const port = createHttpPort({ token: "t", locationId: "loc_demo_0001", fetch: fetchImpl });

  const result = await port.upsertContact({ phone: "+15552010001", assignedTo: "usr_demo_0001" });

  assert.deepEqual(result, { id: "ct_9", created: true });
  assert.deepEqual(requests[0]?.body, { locationId: "loc_demo_0001", phone: "+15552010001", assignedTo: "usr_demo_0001" });
});

test("429 surfaces as a retryable error carrying Retry-After", async () => {
  const { fetchImpl } = recordingFetch(() => new Response("slow down", { status: 429, headers: { "retry-after": "2" } }));
  const port = createHttpPort({ token: "t", locationId: "loc_demo_0001", fetch: fetchImpl });

  await assert.rejects(port.getContact("ct_1"), (err: unknown) => {
    assert.ok(err instanceof GhlHttpError);
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterMs, 2_000);
    return true;
  });
});

test("unenrolling a contact that is not enrolled (404) counts as done", async () => {
  const { fetchImpl } = recordingFetch(() => new Response("not found", { status: 404 }));
  const port = createHttpPort({ token: "t", locationId: "loc_demo_0001", fetch: fetchImpl });
  await port.removeFromWorkflow("ct_1", "wf_demo_0001");
});

test("parses Retry-After as seconds or as an HTTP date", () => {
  assert.equal(parseRetryAfter("5"), 5_000);
  assert.equal(parseRetryAfter(null), undefined);
  const now = Date.parse("2026-03-10T15:00:00Z");
  assert.equal(parseRetryAfter("Tue, 10 Mar 2026 15:00:03 GMT", now), 3_000);
  assert.equal(parseRetryAfter("not a date"), undefined);
});
