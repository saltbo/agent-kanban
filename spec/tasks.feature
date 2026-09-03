Feature: Task lifecycle
  Agents operate Tasks through Realmroot Toolbox while humans observe and
  decide submitted work from the board.

  @journey:tasks/create @entrypoint:toolbox @proof:integration
  Scenario: Create an unassigned Task
    Given an authorized Realmroot actor can write a Board
    When the actor creates a Task through the generic Toolbox operation
    Then AK stores the Task in todo without assigning or dispatching runtime work

  @journey:tasks/assign @entrypoint:toolbox @proof:integration
  Scenario: Assign a Task to a Realmroot Agent
    Given a todo Task exists
    When an authorized actor assigns a Realmroot Agent actor id
    Then AK records the assignment without creating an Agency Session
    And AK sends the assignee an Inbox notification that identifies the Task

  @journey:tasks/claim @entrypoint:toolbox @proof:integration
  Scenario: The assigned Agent claims a Task from its Agency Session
    Given a todo Task is assigned to the authenticated Realmroot Agent
    When the Agent calls task claim with verified Realmroot Agent execution provenance
    Then AK moves the Task to in progress
    And AK binds the Task to that runtime and canonical Agency Session id for observation

  @journey:tasks/release @entrypoint:toolbox @proof:integration
  Scenario: The assignee releases its current Claim
    Given the assigned Agent has claimed the Task
    When that Agent deletes the Claim with its current version
    Then AK returns the Task to todo while preserving the assignment
    And another Agent or a stale Claim version cannot release it

  @journey:tasks/submit-review @entrypoint:toolbox @proof:integration
  Scenario: The assignee submits work for review
    Given the assigned Agent has claimed the Task
    When that Agent creates the Task Review Submission
    Then AK moves the Task to in review and preserves the Session binding
    And the Review Submission exposes the version required for a later review decision

  @journey:tasks/reject-review @entrypoint:toolbox @proof:integration
  Scenario: A different actor rejects submitted work
    Given a Task is in review
    When an authorized actor other than the assignee rejects it with a reason
    Then AK returns the Task to in progress
    And AK sends the assignee an Inbox notification with the rejection reason

  @journey:tasks/complete-review @entrypoint:toolbox @proof:integration
  Scenario: A different actor accepts submitted work
    Given a Task is in review
    When an authorized actor other than the assignee completes it
    Then AK moves the Task to done without closing the Agency Session
    And AK sends the assignee an Inbox notification that the Task was accepted

  @journey:tasks/cancel @entrypoint:toolbox @proof:integration
  Scenario: Cancel an assigned Task
    Given an assigned Task is not done or cancelled
    When an authorized actor cancels it
    Then AK moves the Task to cancelled
    And AK sends the former assignee an Inbox notification that the Task was cancelled

  @journey:tasks/self-review @entrypoint:toolbox @proof:unit
  Scenario: The assignee cannot decide its own submission
    Given a Task is in review
    When the assignee attempts to reject or complete it
    Then AK rejects the decision without changing the Task

  @journey:tasks/wait @entrypoint:toolbox @proof:unit
  Scenario: Wait for a bounded Task condition
    Given a caller supplies Tasks, a target status, and an optional cursor
    When the caller waits for Task events
    Then AK returns when the condition changes, is reached, or the bounded wait expires

  @journey:tasks/structured-fields @entrypoint:toolbox @proof:integration
  Scenario: Preserve Task planning fields
    Given a Task may contain labels, structured input, a schedule, dependencies, and a source Task
    When an authorized actor creates or updates those fields
    Then AK validates referenced resources in the same tenant and Board
    And returns the fields in their typed representations

  @journey:tasks/dependency-blocking @entrypoint:toolbox @proof:integration
  Scenario: Compute whether dependencies block a Task
    Given a Task depends on other Tasks in its Board
    When any dependency is not done
    Then AK reports the Task as blocked
    And AK rejects cyclic or cross-tenant dependency relationships

  @journey:tasks/notes-and-stream @entrypoint:toolbox @proof:integration
  Scenario: Append and follow Task communication
    Given an authorized actor can read a Task
    When actors append Task Notes and follow the Task stream
    Then AK returns the Notes in order through the Task resource
    And the resumable stream emits Task Notes without legacy mailbox messages

  @journey:tasks/human-review @entrypoint:product-ui @proof:e2e
  Scenario: Review submitted work from the board
    Given a human opens a Task in review
    When the human rejects or completes the current Review Submission
    Then the browser sends the canonical version-protected decision resource
    And refreshes the Task from the authoritative response
