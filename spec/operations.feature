Feature: Operational boundaries
  Operators can correlate failures and safely apply the v2 schema.

  @journey:operations/request-observability @entrypoint:http @proof:integration
  Scenario: Correlate every HTTP request
    When AK handles a successful or failed request
    Then it returns a server-generated Request-Id
    And the centralized access middleware emits one structured event at the appropriate level
    And reserved event fields cannot be replaced by extension data

  @journey:operations/v2-upgrade-gate @entrypoint:deployment @proof:integration
  Scenario: Refuse a v2 upgrade with active v1 Tasks
    Given an existing database has v1 Tasks
    When an operator runs the supported migration command
    Then the upgrade continues only if every Task is done or cancelled
    And otherwise reports every blocking Task id without changing its state
