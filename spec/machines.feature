Feature: Machine projections
  AK presents AMA self-hosted Environments as Machines enriched by live Runners.

  @journey:machines/environment-projection @entrypoint:toolbox @proof:integration
  Scenario: Read Machines projected from self-hosted AMA Environments
    Given AMA has cloud and self-hosted Environments for the tenant
    When a caller lists Machines or reads one Machine through AK
    Then only self-hosted Environments appear as Machines
    And AK does not read or persist a local Machine entity

  @journey:machines/create-environment @entrypoint:toolbox @proof:integration
  Scenario: Create the authoritative Machine Environment
    Given the tenant has an authoritative AMA Project
    When an authorized caller creates a Machine
    Then AK creates a real self-hosted AMA Environment
    And returns an ama-runner auth command and start command containing AMA origin, Project id, and Environment id
    And retrying the same Idempotency-Key does not duplicate the Environment
    And AK stores no local Machine entity

  @journey:machines/create-runner-setup @entrypoint:product-ui @proof:e2e
  Scenario: Complete Runner setup from the Add Machine dialog
    Given a human opens Add Machine
    When the human creates a Machine or retries an uncertain attempt
    Then the browser reuses that attempt's Idempotency-Key
    And the browser distinguishes installing AMA Runner from starting this Machine
    And the browser follows the Machine against one absolute 30 second deadline while it comes online
    And an offline timeout offers another explicit status check
    And creation failures remain actionable in the Add Machine dialog

  @journey:machines/runner-aggregation @entrypoint:toolbox @proof:unit
  Scenario: Aggregate live Runner state into a Machine
    Given Runners report heartbeats, runtimes, models, and capacity for a self-hosted Environment
    When AK projects that Environment as a Machine
    Then the Machine reports online state, last heartbeat, runtime inventory, and aggregate current and maximum load

  @journey:machines/archive-environment @entrypoint:toolbox @proof:integration
  Scenario: Archive a Machine's authoritative Environment
    Given a Machine projects an AMA self-hosted Environment
    When an authorized caller deletes the Machine
    Then AK archives the authoritative Environment
    And does not delete a local Machine entity

  @journey:machines/archive-machine-ui @entrypoint:product-ui @proof:e2e
  Scenario: Confirm Machine archival in the browser
    Given a human selects Delete on a Machine
    When the destructive confirmation names the Machine and its current load
    Then the browser submits the archival once
    And archival failures remain actionable in the confirmation dialog
