Feature: Realmroot Resource Server
  AK exposes Board and Task capabilities to Agents through Realmroot Toolbox.

  @resource-server/discovery @api
  Scenario: Publish protected-resource and OpenAPI discovery
    When Realmroot discovers AK
    Then AK publishes protected-resource metadata and its Toolbox OpenAPI document

  @resource-server/generic-operations @api
  Scenario: Use Toolbox generic resource operations
    Given an authorized Realmroot actor
    When the actor reads or writes an ordinary published Board, Task, Note, or Repository resource
    Then Toolbox uses cursor collections, lowerCamelCase representations, and generic verb-first operations
    And omitting API-Version selects the current v2 contract
    And an explicit unsupported API-Version is rejected
    And every generic creation requires an Idempotency-Key

  @resource-server/workflow-commands @api
  Scenario: Publish only AK-specific resource-first commands
    When Toolbox reads the AK OpenAPI document
    Then claim, release, review, reject, complete, cancel, and wait have stable resource-first command names
    And ordinary CRUD does not create duplicate resource-first commands
