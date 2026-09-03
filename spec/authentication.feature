Feature: OIDC sign-in and sessions
  Humans enter AK through the configured OIDC provider while credentials and
  tenant selection stay outside the browser application.

  @journey:authentication/sign-in @entrypoint:product-ui @proof:e2e
  Scenario: Sign in through the configured OIDC provider
    Given a signed-out visitor opens Agent Kanban
    When the visitor chooses sign in
    Then AK starts standard OIDC authorization code flow with PKCE
    And requests the AK resource and the projection scopes used by the server
    And redirects to the currently configured Realmroot provider
    And offers no legacy credential sign-in method

  @journey:authentication/server-session @entrypoint:product-ui @proof:e2e
  Scenario: Keep browser authority in a server-side session
    Given the configured OIDC provider has authenticated a human
    When the callback completes
    Then AK stores an opaque HttpOnly session cookie
    And exposes no access or refresh token to browser storage
    And unsafe requests require the session CSRF token

  @journey:authentication/logout @entrypoint:product-ui @proof:e2e
  Scenario: Sign out locally and at the OIDC provider
    Given a human has an AK browser session
    When the human signs out
    Then AK destroys the local session before using the discovered provider logout endpoint

  @journey:authentication/account @entrypoint:product-ui @proof:e2e
  Scenario: View the Realmroot account identity
    Given a human has an AK browser session
    When the human opens account settings
    Then AK shows the Realmroot identity represented by that session
    And delegates identity management without exposing legacy credentials
