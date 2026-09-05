Feature: Agent projections
  AK presents safe Agent resources sourced from Enbor without owning Agent state.

  @journey:agents/transparent-agency-project @entrypoint:toolbox @proof:integration
  Scenario: The first Agent projection initializes the hidden Agency project binding
    Given the current Realmroot tenant has no stored Agency project binding
    When an Agent lists Agent projections through the AK Resource Server
    Then AK creates or reuses the tenant's project named "Agent Kanban" in Enbor
    And AK persists exactly one tenant-to-project binding before reading Agents
    And concurrent first requests reuse the winning binding

  @journey:agents/agency-binding-migration @entrypoint:deployment @proof:integration
  Scenario: Cut active integration state over to Agency and Enbor contracts
    Given active integration bindings and Task metadata still use the retired AMA names
    When the one-way Enbor contract migration runs
    Then active binding tables and columns use Agency names without compatibility aliases
    And known Task runtime metadata uses Enbor names without changing unrelated text such as llama

  @journey:agents/authoritative-projection @entrypoint:toolbox @proof:integration
  Scenario: Read safe Agent projections from Enbor
    Given Enbor is authoritative for the tenant's Agents
    When a caller lists Agents or reads one Agent through AK
    Then AK preserves every Agent in Enbor's page and its continuation cursor
    And an Agent without a bound identity has null identity fields
    And AK does not read or persist a local Agent entity

  @journey:agents/create-bound-agent @entrypoint:toolbox @proof:integration
  Scenario: Create an Agent with its Realmroot identity
    Given an authorized caller supplies complete Agent configuration
    When the caller creates an Agent through AK
    Then AK creates a same-tenant Realmroot Identity and bound Enbor Agent with the Agent Kanban work skill
    And AK does not create an Inbox Trigger because Task assignment directly creates a Session
    And replays the compound operation without duplicate resources when its Idempotency-Key is retried
    And stores no local Agent entity
    And grants the new identity its default AK and GitHub permissions before returning success
    And a permission failure identifies the created Agent and a retry resumes without duplicates

  @journey:agents/assignment-subject @entrypoint:toolbox @proof:unit
  Scenario: Assign a Task by projected Agent subject
    Given an Agent projection exposes its Realmroot subject
    When an authorized actor assigns that subject as agentActorId
    Then AK stores the subject without calling Enbor or storing an Enbor Agent id

  @journey:agents/read-only-browser @entrypoint:product-ui @proof:e2e
  Scenario: Browse Agents without management controls
    Given the browser loads Agent projections from AK
    When a user opens the Agent list or Agent detail
    Then the pages show Agent identity and scheduling information
    And an Agent without a bound identity remains visible and is marked "Identity not bound"
    And the list filters by search, runtime, and authoritative schedulable state
    And the detail lists AK Tasks whose assignee is the Agent's Realmroot subject
    And the pages offer no create, edit, or archive controls

  @journey:agents/primary-navigation @entrypoint:product-ui @proof:e2e
  Scenario: Open Agent and Machine resources from the primary navigation
    Given a human is using the authenticated product
    When the header is visible on desktop or mobile
    Then Agents and Machines are visible text links in the primary navigation
    And the current resource page is identified as active
    And neither link is duplicated in the account menu

  @journey:agents/public-identity-profile @entrypoint:product-ui @proof:unit
  Scenario: Display current Agent identity details
    Given an Agent or assigned Task exposes a stable Agent subject
    And the configured identity provider publishes public Agent profiles
    When the browser presents that Agent identity
    Then it shows the current profile name and picture
    And repeated appearances of the same subject reuse the cached profile
    And an unavailable profile falls back to the existing Agent name or subject

  @journey:agents/default-permissions @entrypoint:toolbox @proof:unit
  Scenario: New Agents receive permissions before their first task
    Given the creating user has connected GitHub and authorized the required scopes
    When AK provisions a new Agent
    Then AK grants persistent AK permissions in the current tenant Context
    And AK grants the development, Issue, and CI permissions in the connected GitHub Contexts
    And missing scopes fail explicitly instead of returning partial permission success
    And existing Agents are not updated
