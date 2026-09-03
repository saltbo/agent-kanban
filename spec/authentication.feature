Feature: Realmroot sign-in and sessions
  Humans enter AK through Realmroot while credentials and tenant selection stay
  outside the browser application.

  @journey:authentication/sign-in @entrypoint:product-ui @proof:e2e
  Scenario: Sign in only through Realmroot
    Given a signed-out visitor opens Agent Kanban
    When the visitor chooses sign in
    Then AK starts Realmroot authorization code flow with PKCE
    And requests the AK resource and the projection scopes used by the server
    And offers no legacy credential sign-in method

  @journey:authentication/server-session @entrypoint:product-ui @proof:e2e
  Scenario: Keep browser authority in a server-side session
    Given Realmroot has authenticated a human
    When the callback completes
    Then AK stores an opaque HttpOnly session cookie
    And exposes no access or refresh token to browser storage
    And unsafe requests require the session CSRF token

  @journey:authentication/logout @entrypoint:product-ui @proof:e2e
  Scenario: Sign out locally and at Realmroot
    Given a human has an AK browser session
    When the human signs out
    Then AK destroys the local session before redirecting to Realmroot logout

  @journey:authentication/account @entrypoint:product-ui @proof:e2e
  Scenario: View the Realmroot account identity
    Given a human has an AK browser session
    When the human opens account settings
    Then AK shows the Realmroot identity represented by that session
    And delegates identity management without exposing legacy credentials
