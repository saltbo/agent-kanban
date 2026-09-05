# Documentation

The documentation is split by purpose:

- [Product principles](product-principles.md) explains product direction and UI
  preferences; concrete scenarios remain in Spec.
- `architecture/` describes how the system works now. Update it whenever the
  implementation changes.
- `adr/` records consequential decisions, their context, and trade-offs. ADRs
  are immutable after acceptance; supersede an old decision with a new ADR.
- `operations/` contains procedures for deploying, upgrading, or operating the
  system.
- `../spec/` is the source of truth for user-visible product behaviour.

Architecture documents must link to the ADRs that constrain them rather than
repeat decision history. ADRs must describe implemented decisions, not plans or
backlogs. Product scenarios belong in Feature files, not in either directory.
