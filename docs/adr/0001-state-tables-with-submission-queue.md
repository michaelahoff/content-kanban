# State tables with submissions as the durable queue, not event sourcing

Agent work (card chats, submissions, delivery attempts, lane graph runs, requests, artifacts, saved card states) is stored the way Frameboard already stores cards: current-state tables with explicit status columns, plus one append-only activity log that is both the activity timeline and the browser change feed. Queued submission rows are the durable work queue; there is no separate outbox. A triggering change (such as a lane move) writes its graph run and first queued submission in the same transaction. After commit, a wake-up nudges the in-process worker; at startup the worker scans for unfinished rows. Native agent execution never runs inside a SQLite transaction.

## Considered Options

- **T3 Code-style event sourcing** (commands, events, projections, command receipts and an outbox committed together). This was rejected despite being the researched precedent. It needs projection rebuilding and more infrastructure than a small Node/no-build app with one user warrants, and the existing store is already state tables plus event feeds.

## Consequences

- Recovery reads row states; it does not replay events. Changing a table's shape later needs a migration, not a projection rebuild.
- A wake-up only makes work start sooner. Correctness rests on the startup scan and on rows written in the same transaction as their cause.
