Feature: Board observation and management
  Humans organize workspaces and observe Agent work without creating or moving
  Tasks in the board UI.

  @journey:boards/onboarding @entrypoint:product-ui @proof:e2e
  Scenario: Create the first Board after sign-in
    Given a Realmroot user has no Board
    When the user completes onboarding
    Then AK creates the first Board without asking for browser credentials
    And opens that Board

  @journey:boards/observe-work @entrypoint:product-ui @proof:e2e
  Scenario: Observe Tasks in five lifecycle columns
    Given a Board contains Tasks
    When a human opens the Board
    Then AK shows todo, in progress, in review, done, and cancelled columns
    And the Board offers no Task creation or drag-and-drop controls

  @journey:boards/switch-and-create @entrypoint:product-ui @proof:e2e
  Scenario: Switch Boards or open focused Board creation
    Given a human belongs to more than one Board
    When the human uses the Board switcher
    Then the selected Board opens
    And Board creation is presented outside the primary Board surface

  @journey:boards/settings @entrypoint:product-ui @proof:e2e
  Scenario: Update or delete a Board from settings
    Given a human opens Board settings
    When the human changes the name or confirms deletion with the Board id
    Then AK persists the requested change
    And deleting the active Board redirects to another available product state

  @journey:boards/labels @entrypoint:product-ui @proof:e2e
  Scenario: Manage Board labels
    Given a human opens a Board's label settings
    When the human creates or deletes a label
    Then AK updates the Board label catalog
    And removing a label removes it from Tasks on that Board

  @journey:boards/live-notes @entrypoint:product-ui @proof:integration
  Scenario: Follow Board activity
    Given an authenticated human opens a Board
    When new Task Notes are stored for that Board
    Then the resumable Board stream emits only that Board's Note snapshots
    And does not enrich them from legacy Agent rows
