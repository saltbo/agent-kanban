Feature: Agency Session observation
  AK displays the work performed for a Task without owning Agent execution.

  @session-observation/trusted-binding @api
  Scenario: Bind only verified execution provenance
    Given an authenticated Realmroot Agent claims its assigned Task
    When its credential contains Realmroot Remote verified runtime and Session context
    Then AK stores that exact immutable observation binding
    And the claim request has no client writable Session id or socket address

  @session-observation/exact-session @api
  Scenario: Resolve and expose the exact Agency Session
    Given a Task has a verified runtime Session binding
    When an authorized board viewer opens its work activity
    Then AK resolves the matching Agency Session using the assignee, runtime, and runtime Session identifier
    And AK exposes that Session and its canonical event workflow through a read-only proxy
    And AK never infers a latest Session from the Agent identity
