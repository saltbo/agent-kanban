Feature: Repository connections
  Humans connect source repositories to the tenant and Agents reference them
  from Boards and Tasks.

  @journey:repositories/manual-management @entrypoint:product-ui @proof:e2e
  Scenario: Add, browse, and remove a Repository
    Given a human opens Repositories
    When the human adds a valid Repository or removes an existing one
    Then AK updates the tenant-scoped Repository collection
    And management forms appear in focused dialogs rather than the list surface

  @journey:repositories/github-import @entrypoint:product-ui @proof:e2e
  Scenario: Import a Repository from the GitHub App
    Given the tenant has an active GitHub App installation
    When the human browses installable repositories and selects one
    Then AK imports the selected Repository into the tenant

  @journey:repositories/github-lifecycle @entrypoint:webhook @proof:integration
  Scenario: Track GitHub App installation changes
    Given GitHub sends a correctly signed installation or repository event
    When AK processes the webhook
    Then AK updates the tenant installation inventory idempotently
    And repository coverage remains isolated by tenant

  @journey:repositories/pull-request-update @entrypoint:webhook @proof:integration
  Scenario: Apply supported pull request updates without runtime dispatch
    Given a connected Repository has an associated Task
    When GitHub sends a correctly signed pull request event
    Then AK applies the supported Task update
    And does not invoke a removed Maintainer or Session dispatch path
