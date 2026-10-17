# A lane run can create cards, and the cards it creates know their origin

Some flows start from a list: businesses in a town, ideas from a brainstorm, chapters of a long transcript. One card holds the list, and the work that follows is one card per item, each going through the same lanes on its own. Until now the only way to get there was for the user to create each card by hand. A lane playbook can now say that its runs **create cards**:

```
creates:
  lane: Research
  template: Business site
```

- `creates.lane` names a lane of the same flow, by ID or by name; `creates.template` names a card template, by ID or by name. Both are resolved when a run is prepared (`resolveCreates` in `public/playbook-format.js`), and a run whose lane or template is not found reports that instead of guessing.
- The prompt gains a **Creating cards** section listing the new cards' field keys, and the result block gains `"cards": [{ "title", "fields" }]`. `parseLaneResult` checks each card's title and fields against the `creates:` template; a field a card cannot hold is dropped and reported, the card is still created, and a result can create up to 50 cards.
- Created cards are placed at the end of the `creates:` lane with the actor `automation:<attemptId>`, take the lane's `set:` values as any arriving card does, and record the card whose run created them as their **origin** (`cards.parent_id`, `parentId` in the API). The origin card's run summary says how many cards it created.
- A created card placed in a lane whose playbook runs on entry gets a lane run, as if it had been moved there. This is the one exception to ADR 0003's "creating a card never starts an agent": the user did not create the card, a run did, under a playbook the user wrote that names the lane. Automatic moves that follow count toward the same twelve-in-a-row pause as routes (ADR 0009).
- The editor shows a card's origin and the cards a card created, so a fan-out stays navigable.

## Why a playbook setting, not a card tool

Creating cards is authority, like `may_edit`. Putting it in the playbook keeps the grant visible beside the instructions that use it, keeps Codex and Claude identical (one result block), and keeps the flow self-contained for export: the lane and template are named in the file. A card tool would let an agent create cards in any lane of any chat.

## Considered options

- **A list field that the app splits itself** (one card per line). Rejected: deciding what one item is, and what each new card should start with, is the agent's job; the list is rarely clean.
- **Cards as proposals.** Rejected for now: a created card changes nothing on the origin card, and the user can delete it. A review step belongs in the flow's lanes, not in a modal.
- **Joining created cards back into the origin card.** Deferred: the origin link is enough to find them, and a later lane can read sibling cards once a lane run can read other cards.

## Consequences

- `knownKeys` gains `creates`; `playbookSettings` returns `creates`; `describeSettings` mentions it.
- Schema version 22 adds `cards.parent_id`.
- Deleting the origin card leaves its created cards in place; `parentId` still names it.
