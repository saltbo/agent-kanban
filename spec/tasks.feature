Feature: Task lifecycle
  Agents operate Tasks through Realmroot Toolbox while humans observe and
  decide submitted work from the board.

  @journey:tasks/bootstrap-refresh @entrypoint:toolbox @proof:integration
  Scenario: Record refreshed bootstrap expiry without changing execution inputs
    Given a launch has a persisted bootstrap credential reference and Session request
    When its current lease records a successful credential refresh
    Then only the expiry advances while the secretRef and Session request remain fixed
    And older expiries, different credential references, and expired leases cannot overwrite the record

  @journey:tasks/bootstrap-binding @entrypoint:toolbox @proof:integration
  Scenario: Bind bootstrap references to the launch Project
    Given a scheduler has prepared a repository credential
    When it records the bootstrap result under its current lease
    Then AK stores the secretRef, expiry, repository inputs, and Project without the raw token
    And subsequent Session request preparation cannot change that Project
    And a credential response after cancellation remains available for cleanup

  @journey:tasks/settle-launch @entrypoint:toolbox @proof:integration
  Scenario: Settle resources after terminal state or obsolete assignment
    Given a launch belongs to a cancelled, completed, or reassigned Task
    When AK settles the launch
    Then it closes the exact associated Session before revoking the bootstrap credential
    And interrupted cleanup remains pending for recovery
    And Task deletion waits until its Session cleanup completes
    And current active and review Sessions are preserved

  @journey:tasks/reassign-launch @entrypoint:toolbox @proof:integration
  Scenario: Reassign a pending Task with a new launch intent
    Given a todo Task has an assignment and launch intent
    When an authorized actor assigns it to a different Agent
    Then AK atomically records the new assignment and current launch intent
    And an unstarted old intent is replaced and cannot acquire a preparation lease
    And concurrent assignment changes are guarded by the observed Task version

  @journey:tasks/prepare-launch @entrypoint:toolbox @proof:unit
  Scenario: Prepare a Session for the assigned identity and repository
    Given the assigned Realmroot identity resolves to one Agent in the tenant's Enbor Project
    When AK prepares the launch request
    Then it selects that exact Agent and labels the request with the launch id
    And the repository uses a Git volume with an explicit ref, mount path, and secretRef
    And the runtime receives no bootstrap credential environment variables
    And a Task without a repository needs no bootstrap credential
    And missing or ambiguous identity bindings fail before credentials are created

  @journey:tasks/scheduling-not-supported @entrypoint:toolbox @proof:integration
  Scenario: Reject delayed scheduling while retaining the field
    Given delayed Task scheduling is not implemented
    When a caller creates or updates a Task with a non-null scheduledAt
    Then AK returns 422 without persisting the requested change
    And Tasks without scheduledAt can still be created
    And an existing scheduledAt can be cleared with null

  @journey:tasks/launch-claim @entrypoint:toolbox @proof:integration
  Scenario: Claim only the exact eligible launch Session
    Given a Task has a current launch intent
    When its assigned Agent claims it with a verified runtime Session
    Then the Claim commits only for the exact Session recorded on that current launch
    And the Task must have no scheduled time and only terminal dependencies
    And concurrent Claims for that Session create only one Claim

  @journey:tasks/early-claim @entrypoint:toolbox @proof:integration
  Scenario: Reconcile a Claim before the Session creation response is persisted
    Given AK has persisted a Session creation request for the assigned Agent
    When that Agent claims before the creator records the response
    Then AK replays the exact persisted request with its original idempotency key
    And either response writer may record the same Session annotation
    And Claim still verifies its signed Session and the current Task state
    And cancellation during replay keeps the Session receipt but prevents Claim
    And another tenant or unassigned Agent cannot initiate replay

  @journey:tasks/launch-request-binding @entrypoint:toolbox @proof:integration
  Scenario: Persist immutable Session request and exact response separately from Claim
    Given a scheduler holds the current unexpired launch lease
    When it persists the Session creation request
    Then AK rechecks eligibility and stores the tenant Project and exact request once on the Task
    And its exact Session ID is recorded in the server-owned Task annotation
    And client metadata writes cannot forge or erase execution annotations
    And an expired or replaced lease cannot change the request or Session association
    And a Session response arriving after cancellation remains available for cleanup
    And the requested Session association does not create an Agent Claim

  @journey:tasks/launch-eligibility @entrypoint:toolbox @proof:integration
  Scenario: Acquire a lease only for an eligible current launch
    Given a Task has a durable launch intent for its current assignment
    When concurrent schedulers scan for runnable work
    Then only one scheduler acquires an unexpired lease for that intent
    And Tasks with scheduledAt are excluded because delayed scheduling is not implemented
    And dependencies must be done or cancelled
    And cancelled Tasks and superseded assignments are not launched
    And an expired lease can be acquired with a new fencing token

  @journey:tasks/durable-launch-intent @entrypoint:toolbox @proof:integration
  Scenario: Assignment atomically records a durable launch intent
    Given an authorized actor assigns an available Task
    When AK commits the assignment
    Then the assignment and its launch metadata on the Task are committed together
    And repeated assignment to the same Agent creates no additional launch intent
    And failure to persist the launch intent rolls back the assignment
    And recording the intent does not create a Claim or move the Task to in_progress

  @journey:tasks/create @entrypoint:toolbox @proof:integration
  Scenario: Create an unassigned Task
    Given an authorized Realmroot actor can write a Board
    When the actor creates a Task through the generic Toolbox operation
    Then AK stores the Task in todo without assigning or dispatching runtime work

  @journey:tasks/assign @entrypoint:toolbox @proof:integration
  Scenario: Assign a Task to a Realmroot Agent
    Given a todo Task exists
    When an authorized actor patches the Task assignedTo field
    Then AK atomically records the assignment and directly creates its Enbor Session through token exchange
    And AK records the exact Session annotation without creating a Claim
    And AK sends no Inbox startup notification

  @journey:tasks/claim @entrypoint:toolbox @proof:integration
  Scenario: The assigned Agent claims a Task from its Agency Session
    Given a todo Task is assigned to the authenticated Realmroot Agent
    When the Agent posts to the Task Claim collection with verified Realmroot Agent execution provenance
    Then AK moves the Task to in progress
    And AK binds the Task to that runtime and canonical Agency Session id for observation
    And returns the current Claim representation

  @journey:tasks/submit-review @entrypoint:toolbox @proof:integration
  Scenario: The assignee submits work for review
    Given the assigned Agent has claimed the Task
    When that Agent patches the Task status to in review
    Then AK moves the Task to in review and preserves the Session binding
    And returns the updated Task with its next current version

  @journey:tasks/reject-review @entrypoint:toolbox @proof:integration
  Scenario: A different actor rejects submitted work
    Given a Task is in review
    When an authorized actor other than the assignee patches the Task status to in progress with a reason
    Then AK returns the Task to in progress
    And AK sends the feedback to the exact existing Session using delegated authority
    And AK records continuation delivery only after Enbor accepts it
    And a repeated acknowledged decision does not send another prompt

  @journey:tasks/complete-review @entrypoint:toolbox @proof:integration
  Scenario: A different actor accepts submitted work
    Given a Task is in review
    When an authorized actor other than the assignee patches the Task status to done
    Then AK moves the Task to done and closes its directly created Agency Session
    And AK sends no Inbox notification for the terminal transition

  @journey:tasks/cancel @entrypoint:toolbox @proof:integration
  Scenario: Cancel an assigned Task
    Given an assigned Task is not done or cancelled
    When an authorized actor patches the Task status to cancelled
    Then AK moves the Task to cancelled
    And AK sends no Inbox notification for the terminal transition

  @journey:tasks/self-review @entrypoint:toolbox @proof:unit
  Scenario: The assignee cannot decide its own submission
    Given a Task is in review
    When the assignee attempts to patch its status to in progress or done
    Then AK rejects the decision without changing the Task

  @journey:tasks/wait @entrypoint:toolbox @proof:unit
  Scenario: Wait for a bounded Task condition
    Given a caller selects one Task by path and supplies a target status and optional cursor
    When the caller waits on that Task's nested events resource
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
    Then the browser sends a Task status merge patch
    And refreshes the Task from the authoritative response

  @journey:tasks/repository-bootstrap @entrypoint:toolbox @proof:integration
  Scenario: Prepare a private repository with scoped bootstrap credentials
    Given the Task references a Repository owned by its tenant
    And the tenant has connected the GitHub App installation for that repository
    When AK prepares an execution
    Then AK validates the installation's current owner and repository access
    And requests a temporary token for that single repository with contents read permission only
    And freezes the repository URL, default branch, and mount directory for this execution
    And retains the token expiration for control-plane renewal
    And supplies the token only through the Git volume secret reference
    And another tenant's Repository cannot cause a token to be minted
