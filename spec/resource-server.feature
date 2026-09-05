Feature: Realmroot Resource Server
  AK exposes Board and Task capabilities to Agents through Realmroot Toolbox.

  @journey:resource-server/discovery @entrypoint:toolbox @proof:integration
  Scenario: Publish protected-resource and OpenAPI discovery
    When Realmroot discovers AK
    Then AK publishes protected-resource metadata and its Toolbox OpenAPI document

  @journey:resource-server/agent-skills @entrypoint:toolbox @proof:integration
  Scenario: Publish installable Agent Skills
    Given AK owns Agent-facing operating Skills
    When Toolbox discovers Agent Skills at the AK Resource Server origin
    Then AK publishes an Agent Skills Discovery version 0.2.0 index
    And the index advertises every AK-owned Skill as a digest-verified archive
    And each archive contains its Skill instructions and supporting files

  @journey:resource-server/generic-operations @entrypoint:toolbox @proof:integration
  Scenario: Use Toolbox generic resource operations
    Given an authorized Realmroot actor
    When the actor reads or writes an ordinary published Board, Task, Note, or Repository resource
    Then Toolbox uses cursor collections, lowerCamelCase representations, and generic verb-first operations
    And omitting API-Version selects the current v2 contract
    And an explicit unsupported API-Version is rejected
    And Board and Repository creation does not require an Idempotency-Key
    And Task, Task Note, Agent, and Machine creation requires an RFC 8941 string Idempotency-Key

  @journey:resource-server/workflow-commands @entrypoint:toolbox @proof:integration
  Scenario: Publish only AK-specific resource-first commands
    When Toolbox reads the AK OpenAPI document
    Then wait has a stable resource-first command name
    And ordinary CRUD does not create duplicate resource-first commands
