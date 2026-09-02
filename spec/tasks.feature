Feature: Task lifecycle
  Agents operate Tasks through Realmroot Toolbox while humans observe and
  decide submitted work from the board.

  @tasks/create @api
  Scenario: Create an unassigned Task
    Given an authorized Realmroot actor can write a Board
    When the actor creates a Task through the generic Toolbox operation
    Then AK stores the Task in todo without assigning or dispatching runtime work

  @tasks/assign @api
  Scenario: Assign a Task to a Realmroot Agent
    Given a todo Task exists
    When an authorized actor assigns a Realmroot Agent actor id
    Then AK records the assignment without creating an Agency Session
    And AK sends the assignee an Inbox notification that identifies the Task

  @tasks/claim @api
  Scenario: The assigned Agent claims a Task from its Agency Session
    Given a todo Task is assigned to the authenticated Realmroot Agent
    When the Agent calls task claim with Remote verified execution provenance
    Then AK moves the Task to in progress
    And AK binds the Task to that runtime and Session resume token for observation

  @tasks/submit-review @api
  Scenario: The assignee submits work for review
    Given the assigned Agent has claimed the Task
    When that Agent creates the Task Review Submission
    Then AK moves the Task to in review and preserves the Session binding
    And the Review Submission exposes the version required for a later review decision

  @tasks/reject-review @api
  Scenario: A different actor rejects submitted work
    Given a Task is in review
    When an authorized actor other than the assignee rejects it with a reason
    Then AK returns the Task to in progress
    And AK sends the assignee an Inbox notification with the rejection reason

  @tasks/complete-review @api
  Scenario: A different actor accepts submitted work
    Given a Task is in review
    When an authorized actor other than the assignee completes it
    Then AK moves the Task to done without closing the Agency Session
    And AK sends the assignee an Inbox notification that the Task was accepted

  @tasks/cancel @api
  Scenario: Cancel an assigned Task
    Given an assigned Task is not done or cancelled
    When an authorized actor cancels it
    Then AK moves the Task to cancelled
    And AK sends the former assignee an Inbox notification that the Task was cancelled

  @tasks/self-review @usecase
  Scenario: The assignee cannot decide its own submission
    Given a Task is in review
    When the assignee attempts to reject or complete it
    Then AK rejects the decision without changing the Task

  @tasks/wait @usecase
  Scenario: Wait for a bounded Task condition
    Given a caller supplies Tasks, a target status, and an optional cursor
    When the caller waits for Task events
    Then AK returns when the condition changes, is reached, or the bounded wait expires
