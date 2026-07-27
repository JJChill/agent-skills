# Glossary

<!--
Ubiquitous-language glossary (see the ubiquitous-language skill).
Copy to docs/GLOSSARY.md and point the probity config's glossaryPath
at it.

Format convention — the probity rules parse this file:
- one term per level-2 heading: `## Term`
- one term per concept, one concept per term; no aliases — if two
  words compete for a concept, hold the glossary conversation and
  record the winner
- definition text below the heading is free-form; record decisions
  ("was called X until 2026-07; renamed because...") in the entry
- multi-word terms are matched in code as PascalCase / camelCase /
  snake_case, so `## Delivery Window` covers DeliveryWindow,
  deliveryWindow, delivery_window

Enforcement, when wired in probity.config:
- renaming/removing a term still used by specs, tests, or code blocks
  the glossary edit with the list of users (surfaceGlossaryTermBreakage)
- spec content naming a recorded concept with a conflicting term is
  blocked (enforceAcceptanceLanguage with glossaryPath)
- port/domain names conflicting with recorded terms are blocked
  (enforcePortsBoundary with glossaryPath)
- optional strict mode: spec concepts with no entry at all are blocked
  (enforceAcceptanceLanguage with requireGlossaryEntry: true)
-->

## Example Term

Replace with your first real term. State what the concept is in the
problem domain's own words, not how the system implements it.
