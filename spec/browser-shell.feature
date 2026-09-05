Feature: Public browser navigation and appearance
  Visitors can explore the product without an account and recover from invalid
  navigation while their chosen appearance is respected.

  @journey:browser-shell/local-demo @entrypoint:product-ui @proof:e2e
  Scenario: Explore a self-contained Agent demonstration
    Given a visitor opens the product introduction
    When the demonstration shows Agents claiming and reviewing work
    Then demo Agent identities remain local to the demonstration
    And no live identity lookup is made for a demo Agent

  @journey:browser-shell/documentation @entrypoint:product-ui @proof:e2e
  Scenario: Find the product documentation
    Given a visitor opens the product introduction
    When the visitor chooses Documentation
    Then the link leads to the project documentation

  @journey:browser-shell/not-found @entrypoint:product-ui @proof:e2e
  Scenario: Recover from an unknown page
    Given a visitor opens a page that does not exist
    Then the visitor sees a page-not-found explanation
    And can return to the product home

  @journey:browser-shell/theme-preference @entrypoint:product-ui @proof:e2e
  Scenario: Start dark and preserve an explicit appearance choice
    Given a visitor has not chosen an appearance
    Then the product starts in dark mode
    When the visitor has previously chosen light, dark, or system appearance
    Then the product respects that choice on the next visit
