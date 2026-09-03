Feature: Agent projections
  AK presents safe Agent resources sourced from AMA without owning Agent state.

  @journey:agents/transparent-ama-project @entrypoint:toolbox @proof:integration
  Scenario: The first Agent projection initializes the hidden AMA project
    Given the current Realmroot tenant has no stored AMA project binding
    When an Agent lists Agent projections through the AK Resource Server
    Then AK creates or reuses the tenant's project named "Agent Kanban" in AMA
    And AK persists exactly one tenant-to-project binding before reading Agents
    And concurrent first requests reuse the winning binding
  @journey:agents/authoritative-projection @entrypoint:toolbox @proof:integration
  Scenario: Read safe Agent projections from AMA
    Given AMA is authoritative for the tenant's Agents
    When a caller lists Agents or reads one Agent through AK
    Then AK preserves every Agent in AMA's page and its continuation cursor
    And an Agent without a bound identity has null identity fields
    And AK does not read or persist a local Agent entity

  @journey:agents/create-bound-agent @entrypoint:toolbox @proof:integration
  Scenario: Create an Agent with its Realmroot identity
    Given an authorized caller supplies complete Agent configuration
    When the caller creates an Agent through AK
    Then AK creates a same-tenant Realmroot Identity and bound AMA Agent
    And replays the compound operation without duplicate resources when its Idempotency-Key is retried
    And stores no local Agent entity

  @journey:agents/assignment-subject @entrypoint:toolbox @proof:unit
  Scenario: Assign a Task by projected Agent subject
    Given an Agent projection exposes its Realmroot subject
    When an authorized actor assigns that subject as agentActorId
    Then AK stores the subject without calling AMA or storing an AMA Agent id

  @journey:agents/read-only-browser @entrypoint:product-ui @proof:e2e
  Scenario: Browse Agents without management controls
    Given the browser loads Agent projections from AK
    When a user opens the Agent list or Agent detail
    Then the pages show Agent identity and scheduling information
    And an Agent without a bound identity remains visible and is marked "Identity not bound"
    And the list filters by search, runtime, and authoritative schedulable state
    And the detail lists AK Tasks whose assignee is the Agent's Realmroot subject
    And the pages offer no create, edit, or archive controls

  @journey:agents/public-identity-profile @entrypoint:product-ui @proof:unit
  Scenario: Display current Agent identity details
    Given an Agent or assigned Task exposes a stable Agent subject
    And the configured identity provider publishes public Agent profiles
    When the browser presents that Agent identity
    Then it shows the current profile name and picture
    And repeated appearances of the same subject reuse the cached profile
    And an unavailable profile falls back to the existing Agent name or subject
