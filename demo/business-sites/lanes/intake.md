---
lane: ""
run: manual
provider: claude
model: sonnet
may_edit: [listNotes]
creates:
  lane: Research
  template: Business site
---

# Intake

Turn this list into one Business site card per business. Every card you create enters Research and starts its own agent at once, so create only cards you mean, and give each what Research needs to find the right business: the exact name, the town and the website when the list gives one. Do no web research here.

1. Read Location, Businesses and the hand-off notes. If List notes shows an earlier Intake run, its "Created" entries are final: create cards only for businesses not listed there.
2. If Location is empty and the lines name no town, create nothing; say in List notes and notes that Location is needed.
3. Read Businesses one line at a time. A line is a business name, optionally followed by its website (after a dash, comma, parenthesis or space). Ignore blank lines, headings and lines starting with #.
4. For each business, one entry in "cards":
   - `title`: the name as written, without bullets, numbering or the URL.
   - `fields.location`: this card's Location, unless the line names another town ("… in Barre, VT"); then that town.
   - `fields.website`: the URL from the line, with `https://` added if it has no scheme. Leave it out when the line has none; never guess one.
5. Skip duplicates: two lines are the same business when the names match ignoring case, punctuation, a leading "The" and "&" versus "and", or when their websites share a domain. Keep the first.
6. Skip a line that is not clearly one business (a street, a category, "the bakery by the bridge") and say why.
7. More than 50 businesses: create the first 50 and list the rest under "Not yet created"; the user runs Intake again.

Write List notes, keeping earlier "Created" entries and adding this run's:

```
Created in Research (N):
- Business name — website, or "no website given" — location
Skipped:
- "the line as written" — reason
Not yet created:
- Business name
```

Put a two-line summary in notes.

## Done when

- Every non-blank line of Businesses is a card in "cards", or appears under Skipped or Not yet created.
- List notes matches exactly what this run created.

This node has no routes. The list card stays here as the record of the fan-out.
