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
    Given Realmroot Remote signed a Task binding whose session_id is the canonical Agency Session id
    When an authorized board viewer opens its work activity
    Then AK uses the current caller's delegated authority and tenant-mapped Agency Project to read the standard Session resource by id
    And AK verifies that the Session uid and projectId match the signed binding and mapped Project
    And AK exposes the standard Session socket through a read-only proxy without downstream-specific Agency lookup logic
    And AK never infers a latest Session from the Agent identity
