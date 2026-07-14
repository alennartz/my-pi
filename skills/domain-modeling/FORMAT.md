# glossary.md Format

## Structure

```md
# {Project Name} Glossary

{One or two sentence description of what this project is, as context for the terms.}

## Language

**Order**:
{A one or two sentence description of the term}
_Avoid_: Purchase, transaction

**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: Bill, payment request

**Customer**:
A person or organization that places orders.
_Avoid_: Client, buyer, account

## Relationships

- A **Customer** places many **Orders**
- An **Order** produces one **Invoice** on delivery

## Flagged ambiguities

- "account" was used for both Customer and User — resolved: the paying entity is the **Customer**; "account" is no longer a domain term.
```

## Rules

- **Be opinionated.** When multiple words exist for the same concept, pick the best one and list the others under `_Avoid_`.
- **Keep definitions tight.** One or two sentences max. Define what it IS, not what it does.
- **Only include terms specific to this project.** General programming concepts (timeouts, error types, utility patterns) don't belong even if the project uses them extensively. Before adding a term, ask: is this a concept unique to this project, or a general programming concept? Only the former belongs.
- **Group terms under subheadings** when natural clusters emerge. If all terms belong to a single cohesive area, a flat list is fine.
- **A glossary and nothing else.** No implementation details, no specs, no scratch notes. Structure belongs in `codemap.md`; decisions belong in decision records.
- **Relationships and Flagged ambiguities are optional sections** — include them when there's something to say.
