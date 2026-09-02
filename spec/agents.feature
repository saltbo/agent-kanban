Feature: Agent projections
  AK presents safe Agent resources sourced from AMA without owning Agent state.

  @agents/transparent-ama-project @api
  Scenario: Sign-in initializes the hidden AMA project
    Given the current Realmroot tenant has no stored AMA project binding
    When a user signs in to AK through Realmroot
    Then AK creates or reuses the tenant's project named "Agent Kanban" in AMA
    And AK persists exactly one tenant-to-project binding before establishing the web session
    And AMA-backed Resource operations never initialize a missing Project lazily
  @agents/authoritative-projection @api
  Scenario: Read safe Agent projections from AMA
    Given AMA is authoritative for the tenant's Agents
    When a caller lists Agents or reads one Agent through AK
    Then AK returns only the safe product projection including the Realmroot subject
    And AK does not read or persist a local Agent entity

  @agents/assignment-subject @usecase
  Scenario: Assign a Task by projected Agent subject
    Given an Agent projection exposes its Realmroot subject
    When an authorized actor assigns that subject as agentActorId
    Then AK stores the subject without calling AMA or storing an AMA Agent id

  @agents/read-only-browser @web
  Scenario: Browse Agents without management controls
    Given the browser loads Agent projections from AK
    When a user opens the Agent list or Agent detail
    Then the pages show Agent identity and scheduling information
    And the list filters by search, runtime, and authoritative schedulable state
    And the detail lists AK Tasks whose assignee is the Agent's Realmroot subject
    And the pages offer no create, edit, or archive controls
