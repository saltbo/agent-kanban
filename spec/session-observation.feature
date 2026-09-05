Feature: Agency Session observation
  AK displays the work performed for a Task without owning Agent execution.

  @journey:session-observation/trusted-binding @entrypoint:toolbox @proof:integration
  Scenario: Bind only verified execution provenance
    Given an authenticated Realmroot Agent claims its assigned Task
    When its Realmroot-issued credential contains verified runtime and Session context
    Then AK stores that exact immutable observation binding
    And the claim request has no client writable Session id or socket address

  @journey:session-observation/exact-session @entrypoint:product-ui @proof:integration
  Scenario: Resolve and expose the exact Agency Session
    Given a server-owned Task annotation or legacy verified Agent binding contains the canonical Agency Session id
    When an authorized board viewer opens its work activity
    Then AK uses the current caller's delegated authority and tenant-mapped Agency Project to read the standard Session resource by id
    And AK verifies that the Session uid and projectId match the stored Session id and mapped Project
    And a directly created Session is observable before its Agent claims the Task
    And AK exposes the standard Session socket through a read-only proxy without downstream-specific Agency lookup logic
    And AK never infers a latest Session from the Agent identity
