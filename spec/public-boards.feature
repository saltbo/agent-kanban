Feature: Public Board sharing
  A Board owner may publish a read-only view without exposing authenticated
  management capabilities.

  @journey:public-boards/mobile-view @entrypoint:product-ui @proof:e2e
  Scenario: Browse a published Board on a phone
    Given a public Board has a Todo Task
    When an unauthenticated visitor opens the Board on a phone
    Then the Todo status tab shows that Task
    And choosing another status shows only Tasks in that status
    And returning to Todo shows the original Task

  @journey:public-boards/shared-view @entrypoint:public-http @proof:integration
  Scenario: Read a published Board by its share slug
    Given a Board is public
    When an unauthenticated visitor opens its share URL
    Then AK returns the read-only public Board representation
    And a private or unknown Board is not exposed

  @journey:public-boards/live-view @entrypoint:public-http @proof:integration
  Scenario: Follow public Board updates
    Given an unauthenticated visitor is viewing a public Board
    When Task Notes update that Board
    Then the public resumable stream emits the safe Board update

  @journey:public-boards/task-badge @entrypoint:public-http @proof:integration
  Scenario: Render the canonical Tasks badge
    Given a Board is public
    When a visitor requests its badge
    Then AK reports completed Tasks without reading legacy Agent data
    And removed Agent and token badge types are rejected
