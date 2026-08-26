Feature: Password reset

  Users who forget their password can request reset instructions and set a new password
  without exposing whether an email address is registered.

  Background:
    Given password reset is available

  Scenario: Send reset instructions for a registered email
    Given a registered user exists with email "sam@example.com"
    When the user requests a password reset for "sam@example.com"
    Then the request succeeds
    And reset instructions are sent to "sam@example.com"

  Scenario: Do not disclose whether an email is registered
    Given no user exists with email "unknown@example.com"
    When the user requests a password reset for "unknown@example.com"
    Then the request succeeds
    And the response does not reveal whether the email is registered
    And no reset instructions are sent

  Scenario: Accept a valid reset token
    Given a registered user has requested a password reset
    And the user has a valid reset token
    When the user sets a new valid password with that token
    Then the password is changed
    And the reset token can no longer be used

  Scenario: Reject an expired reset token
    Given a registered user has an expired reset token
    When the user tries to set a new password with that token
    Then the password is not changed
    And the user is told to request a new reset link
