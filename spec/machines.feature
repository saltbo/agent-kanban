Feature: Machine projections
  AK presents AMA self-hosted Environments as Machines enriched by live Runners.

  @machines/environment-projection @api
  Scenario: Read Machines projected from self-hosted AMA Environments
    Given AMA has cloud and self-hosted Environments for the tenant
    When a caller lists Machines or reads one Machine through AK
    Then only self-hosted Environments appear as Machines
    And AK does not read or persist a local Machine entity

  @machines/create-runner-setup @usecase
  Scenario: Create a Machine and complete Runner setup command
    Given the tenant has an authoritative AMA Project
    When an authorized caller creates a Machine
    Then AK creates a real self-hosted AMA Environment
    And returns an ama-runner auth command and start command containing AMA origin, Project id, and Environment id
    And retrying the same browser creation attempt reuses its Idempotency-Key
    And the browser distinguishes installing AMA Runner from starting this Machine
    And the browser follows the Machine against one absolute 30 second deadline while it comes online
    And an offline timeout offers another explicit status check
    And creation failures remain actionable in the Add Machine dialog

  @machines/runner-aggregation @usecase
  Scenario: Aggregate live Runner state into a Machine
    Given Runners report heartbeats, runtimes, models, and capacity for a self-hosted Environment
    When AK projects that Environment as a Machine
    Then the Machine reports online state, last heartbeat, runtime inventory, and aggregate current and maximum load

  @machines/archive-environment @usecase
  Scenario: Delete a Machine by archiving its Environment
    Given a Machine projects an AMA self-hosted Environment
    When an authorized caller deletes the Machine
    Then AK archives the authoritative Environment
    And does not delete a local Machine entity
    And archival failures remain actionable in the confirmation dialog
