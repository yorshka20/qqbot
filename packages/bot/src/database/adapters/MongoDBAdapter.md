# MongoDBAdapter — outstanding requirements

**Status: not implemented.** The deployed database is SQLite; this records what MongoDB has to
satisfy before it can be selected, so the work is not re-derived from scratch later.

## The contract

`ModelAccessor<T>` promises `T`. Both adapters must therefore honour **identity**: a value written
through the accessor comes back out of it as the same value, in the type the model declares.

This is not automatic. Neither store holds every JS type natively, so each adapter converts on the
way in — and **a conversion implemented on only one side is a silent bug**. It survives `tsc`
(the field satisfies its declared type at every call site; the lie is in the runtime conversion)
and it survives ordinary tests (writing and reading through the same wrong assumption still
agrees with itself). It surfaces much later as a comparison that is quietly always false.

`__tests__/SQLiteAdapter.roundTrip.test.ts` is the executable form of this contract. Treat it as
the specification, not as SQLite-specific tests.

## What MongoDB must do

### 1. Mirror the round-trip test suite

There are currently **no tests for MongoDBAdapter**. Port the round-trip suite against a real
MongoDB (testcontainers or a disposable local instance) rather than a mock — a mock re-encodes the
assumption under test and proves nothing. Every assertion in the SQLite suite must hold verbatim;
the point is that callers cannot tell the adapters apart.

Adapter-specific handling that is *correct to omit* still needs a test proving the observable
result matches. MongoDB stores objects, booleans and dates natively, so it needs neither the JSON
parse nor the `booleanFields` restoration that SQLite needs — but the field must still read back as
an object / boolean / Date, and only a test says so.

### 2. Migrate documents written under the old `metadata` shape

`AgendaItem.metadata` was once declared `string` holding JSON text, and MongoDB stored exactly
that string. It is now `Record<string, unknown>` and MongoDB stores the object. Any document
written before that change reads back as a **string**, and every consumer now expects an object —
so `metadata.source` is `undefined` and provenance checks silently fail.

A one-off migration must parse those strings into objects. Do not make the readers accept both
shapes: two shapes for one field is the defect this came from.

### 3. Decide the semantics of `find()` on an object-valued field

The two adapters currently disagree, and neither behaviour is documented:

- SQLite stringifies an object criterion and compares it against the stored JSON **text**, so it is
  an exact, key-order-sensitive whole-value match.
- MongoDB passes the object straight through as a filter, which matches by **subdocument
  equality** — different rules, and a partial-match filter (`{ metadata: { source: 'llm' } }`)
  behaves differently again.

Pick one meaning, state it on `ModelAccessor.find`, and test it on both adapters. Until then, do
not filter on an object-valued field.

### 4. Match the runtime guards on `update()`

`SQLiteModelAccessor.update` skips `id` and `createdAt` even though the parameter type already
forbids them; MongoDB's `$set` does not, so a caller reaching past the types can rewrite a
primary key or forge a creation time on one adapter but not the other.

## Also worth knowing

`SQLiteModelAccessor.create` and its MongoDB counterpart both honour a caller-supplied `id` and
otherwise mint a UUID. Agenda items rely on this to number themselves; see
`AgendaService.allocateId`. The MongoDB id-renumbering migration that the SQLite adapter performs
for `agenda_items` has no MongoDB equivalent yet.
