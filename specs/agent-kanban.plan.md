# Agent Kanban — archived pre-Realmroot UI test plan

> **Archived:** This document describes the removed Better Auth, GitHub user
> OAuth, static API-key, and GPG onboarding architecture. It is retained only
> as historical context and must not be used as the current implementation or
> acceptance-test contract. Use `README.md` and
> `docs/realmroot-native-cutover.md` for the Realmroot Native contract.

## Application Overview

Agent Kanban is a React SPA backed by a Hono API on Cloudflare Pages + D1. It provides an agent-first kanban board for managing AI-driven tasks. The app uses email/password and GitHub OAuth authentication (Better Auth). After sign-in, users manage boards (5-column kanban), machines (daemon runners), agents (AI workers with cryptographic identity), and repositories. All pages except /auth and /auth/callback are behind a ProtectedRoute that redirects unauthenticated users to /auth.

## Test Scenarios

### 1. Authentication

**Seed:** `tests/seed.spec.ts`

#### 1.1. Auth page renders sign-in form by default

**File:** `tests/auth/auth-page-default-state.spec.ts`

**Steps:**
  1. Navigate to http://localhost:6265/auth
    - expect: The page title 'Agent Kanban' is visible with 'Kanban' in accent color
    - expect: The subtitle 'Sign in to your account' is visible
    - expect: An email input field is present
    - expect: A password input field is present
    - expect: A 'Sign In' submit button is visible
    - expect: A 'Continue with GitHub' button is visible
    - expect: A 'Sign up' toggle link is visible
    - expect: The Name field is NOT present (sign-up only field)

#### 1.2. Switch between sign-in and sign-up modes

**File:** `tests/auth/auth-mode-toggle.spec.ts`

**Steps:**
  1. Navigate to http://localhost:6265/auth
    - expect: Page is in sign-in mode, subtitle reads 'Sign in to your account'
  2. Click the 'Sign up' toggle link at the bottom of the form
    - expect: The form switches to sign-up mode
    - expect: Subtitle changes to 'Create a new account'
    - expect: A 'Name' input field appears above the email field
    - expect: The submit button label changes to 'Sign Up'
    - expect: The toggle link at the bottom changes to 'Sign in'
  3. Click the 'Sign in' toggle link at the bottom
    - expect: The form switches back to sign-in mode
    - expect: The Name field disappears
    - expect: Subtitle returns to 'Sign in to your account'
    - expect: Submit button label returns to 'Sign In'

#### 1.3. Sign-in form validation — empty fields

**File:** `tests/auth/auth-signin-empty-validation.spec.ts`

**Steps:**
  1. Navigate to http://localhost:6265/auth
    - expect: Sign-in form is displayed
  2. Click the 'Sign In' button without entering any credentials
    - expect: The form does not submit
    - expect: Browser native validation or an error state prevents submission because the email field is required

#### 1.4. Sign-in form validation — invalid email format

**File:** `tests/auth/auth-signin-invalid-email.spec.ts`

**Steps:**
  1. Navigate to http://localhost:6265/auth
    - expect: Sign-in form is displayed
  2. Type 'notanemail' into the email field and 'password123' into the password field, then click 'Sign In'
    - expect: The form does not submit
    - expect: Browser native email validation blocks the submission or an error message is shown

#### 1.5. Sign-in with wrong credentials shows error

**File:** `tests/auth/auth-signin-wrong-credentials.spec.ts`

**Steps:**
  1. Navigate to http://localhost:6265/auth
    - expect: Sign-in form is displayed
  2. Enter 'wrong@example.com' in the email field and 'wrongpassword' in the password field
  3. Click the 'Sign In' button
    - expect: An error message is displayed below the password field (in the error text area styled with 'text-error')
    - expect: The user remains on the /auth page
    - expect: The submit button returns from its loading '...' state back to 'Sign In'

#### 1.6. Sign-up form validation — password minimum length

**File:** `tests/auth/auth-signup-password-minlength.spec.ts`

**Steps:**
  1. Navigate to http://localhost:6265/auth and click the 'Sign up' link to switch to sign-up mode
    - expect: Sign-up form is displayed with Name, Email, and Password fields
  2. Enter 'Test User' in Name, 'test@example.com' in Email, and 'short' (5 characters) in Password, then click 'Sign Up'
    - expect: The form does not submit
    - expect: Browser native minlength validation fires (password has minLength=8) preventing submission, or an inline error is shown

#### 1.7. Sign-up form validation — empty name field

**File:** `tests/auth/auth-signup-empty-name.spec.ts`

**Steps:**
  1. Navigate to http://localhost:6265/auth and switch to sign-up mode
    - expect: Sign-up form is displayed
  2. Leave Name blank, enter 'test@example.com' in Email and 'validpassword' in Password, then click 'Sign Up'
    - expect: The form does not submit because the Name field is required
    - expect: Browser native validation or an inline error prevents the action

#### 1.8. Sign-up with existing email shows error

**File:** `tests/auth/auth-signup-duplicate-email.spec.ts`

**Steps:**
  1. Navigate to http://localhost:6265/auth and switch to sign-up mode
    - expect: Sign-up form is displayed
  2. Enter 'Existing User' in Name, an already-registered email in Email, and a valid password with at least 8 characters in Password, then click 'Sign Up'
    - expect: An error message is displayed indicating the email is already in use or sign-up failed
    - expect: The user remains on the /auth page

#### 1.9. Loading state is displayed during sign-in submission

**File:** `tests/auth/auth-signin-loading-state.spec.ts`

**Steps:**
  1. Navigate to http://localhost:6265/auth
    - expect: Sign-in form is displayed with the 'Sign In' button
  2. Enter any email and password, then click 'Sign In'
    - expect: The submit button immediately changes its text to '...' and becomes disabled while the request is in flight
    - expect: The button re-enables (with the original label or with an error) once the response arrives

#### 1.10. GitHub OAuth button is present and interactive

**File:** `tests/auth/auth-github-oauth-button.spec.ts`

**Steps:**
  1. Navigate to http://localhost:6265/auth
    - expect: The 'Continue with GitHub' button is visible with the GitHub SVG icon
  2. Observe the button; note it is clickable (not disabled)
    - expect: The button is not disabled and triggers a navigation to GitHub OAuth when clicked (or initiates the OAuth flow — the exact redirect to GitHub is acceptable as a test result)

#### 1.11. Error is cleared when switching auth modes

**File:** `tests/auth/auth-error-clears-on-mode-switch.spec.ts`

**Steps:**
  1. Navigate to http://localhost:6265/auth
    - expect: Sign-in form is displayed
  2. Attempt to sign in with 'bad@example.com' and 'badpassword' to produce an error message
    - expect: An error message is displayed in the form
  3. Click the 'Sign up' toggle link to switch to sign-up mode
    - expect: The error message is no longer visible (the component calls setError(null) on mode switch)

#### 1.12. Auth callback page shows loading state

**File:** `tests/auth/auth-callback-loading.spec.ts`

**Steps:**
  1. Navigate directly to http://localhost:6265/auth/callback
    - expect: The page shows the text 'Signing in...' centered on screen while the session is being resolved
  2. Wait for the session resolution to complete
    - expect: The user is redirected either to '/' (if a valid session was found) or back to '/auth' (if no session)

### 2. Routing and Navigation Guards

**Seed:** `tests/seed.spec.ts`

#### 2.1. Root URL redirects unauthenticated user to /auth

**File:** `tests/routing/unauthenticated-root-redirect.spec.ts`

**Steps:**
  1. Clear all cookies and local storage to ensure no session exists, then navigate to http://localhost:6265/
    - expect: The browser is redirected to http://localhost:6265/auth
    - expect: The sign-in form is displayed

#### 2.2. Protected board URL redirects unauthenticated user to /auth

**File:** `tests/routing/unauthenticated-board-redirect.spec.ts`

**Steps:**
  1. With no active session, navigate to http://localhost:6265/boards/some-board-id
    - expect: The browser is redirected to /auth
    - expect: The sign-in form is displayed

#### 2.3. Protected machines URL redirects unauthenticated user to /auth

**File:** `tests/routing/unauthenticated-machines-redirect.spec.ts`

**Steps:**
  1. With no active session, navigate to http://localhost:6265/machines
    - expect: The browser is redirected to /auth
    - expect: The sign-in form is displayed

#### 2.4. Protected agents URL redirects unauthenticated user to /auth

**File:** `tests/routing/unauthenticated-agents-redirect.spec.ts`

**Steps:**
  1. With no active session, navigate to http://localhost:6265/agents
    - expect: The browser is redirected to /auth

#### 2.5. Protected settings URL redirects unauthenticated user to /auth

**File:** `tests/routing/unauthenticated-settings-redirect.spec.ts`

**Steps:**
  1. With no active session, navigate to http://localhost:6265/settings
    - expect: The browser is redirected to /auth

#### 2.6. Protected repositories URL redirects unauthenticated user to /auth

**File:** `tests/routing/unauthenticated-repos-redirect.spec.ts`

**Steps:**
  1. With no active session, navigate to http://localhost:6265/repositories
    - expect: The browser is redirected to /auth

### 3. Board Page

**Seed:** `tests/seed.spec.ts`

#### 3.1. Board page renders five kanban columns

**File:** `tests/board/board-five-columns.spec.ts`

**Steps:**
  1. Sign in with valid credentials and navigate to a board at /boards/:boardId
    - expect: The board page is displayed
    - expect: Five columns are visible: Todo, In Progress, In Review, Done, Cancelled
    - expect: Each column header shows the column name and a task count badge

#### 3.2. Create a new task via the Todo column '+' button

**File:** `tests/board/board-create-task.spec.ts`

**Steps:**
  1. Sign in and navigate to a board page
    - expect: The board is displayed with a '+ Task' button in the Todo column
  2. Click the '+ Task' button in the Todo column
    - expect: An inline text input appears with focus set on it and placeholder text 'Task title...'
  3. Type 'My new task' in the input and press Enter
    - expect: The input disappears
    - expect: A new task card titled 'My new task' appears in the Todo column
    - expect: The Todo column task count increments by 1
    - expect: The new card briefly highlights (animate-card-highlight) to indicate it is newly created

#### 3.3. Cancel task creation by pressing Escape

**File:** `tests/board/board-cancel-task-creation.spec.ts`

**Steps:**
  1. Sign in and navigate to a board page
    - expect: Board is displayed
  2. Click '+ Task' in the Todo column to open the inline input
    - expect: Input field is visible
  3. Press the Escape key without typing anything
    - expect: The input field is dismissed
    - expect: No new task is created
    - expect: The '+ Task' button reappears

#### 3.4. Cancel task creation by blurring with empty input

**File:** `tests/board/board-cancel-task-blur.spec.ts`

**Steps:**
  1. Sign in and navigate to a board page. Click '+ Task' to open the inline input.
    - expect: Input is visible
  2. Click somewhere else on the page (blur the input) without typing
    - expect: The input is hidden (onBlur cancels if the title is empty)
    - expect: The '+ Task' button reappears
    - expect: No task is created

#### 3.5. Click a task card to open the task detail sheet

**File:** `tests/board/board-open-task-detail.spec.ts`

**Steps:**
  1. Sign in and navigate to a board with at least one task
    - expect: Task cards are visible in the board columns
  2. Click on any task card
    - expect: A side-sheet slides in from the right
    - expect: The sheet displays the task title
    - expect: The sheet shows Status, Assigned to, Duration fields
    - expect: A Description editable area is present
    - expect: An Activity log section is present

#### 3.6. Close task detail sheet

**File:** `tests/board/board-close-task-detail.spec.ts`

**Steps:**
  1. Sign in, navigate to a board, and click a task card to open the detail sheet
    - expect: Task detail sheet is open
  2. Click the '✕' close button in the sheet header
    - expect: The task detail sheet closes
    - expect: The board view is restored without the sheet

#### 3.7. Task detail sheet shows Details and Chat tabs when task is assigned

**File:** `tests/board/board-task-detail-tabs.spec.ts`

**Steps:**
  1. Sign in, navigate to a board, and open the detail sheet for a task that has an agent assigned
    - expect: Two tabs are visible: 'Details' and 'Chat'
    - expect: The 'Details' tab is active by default
  2. Click the 'Chat' tab
    - expect: The chat panel is displayed showing the conversation area for the task

#### 3.8. Task detail — edit task title inline

**File:** `tests/board/board-task-edit-title.spec.ts`

**Steps:**
  1. Sign in, navigate to a board, and open the task detail sheet for a todo task
    - expect: Task title is displayed as editable text
  2. Click on the task title to activate the inline editor, clear the current title, type 'Updated task title', and save (press Enter or click away)
    - expect: The title in the sheet updates to 'Updated task title'
    - expect: The corresponding task card in the board column also shows the updated title

#### 3.9. Task detail — complete a task

**File:** `tests/board/board-task-complete.spec.ts`

**Steps:**
  1. Sign in, navigate to a board, and open the detail sheet for a task in 'In Review' status
    - expect: The task detail sheet shows the status as 'In Review'
    - expect: A 'Complete' action button is visible (allowed for user role on in_review tasks)
  2. Click the 'Complete' button
    - expect: The task status updates to 'Done'
    - expect: The task card moves to the Done column on the board
    - expect: The detail sheet reflects the new 'Done' status

#### 3.10. Task detail — cancel a task

**File:** `tests/board/board-task-cancel.spec.ts`

**Steps:**
  1. Sign in, navigate to a board, open the task detail sheet for a 'Todo' task that has no agent assigned
    - expect: A 'Cancel' action button is visible
  2. Click the 'Cancel' button
    - expect: The task status updates to 'Cancelled'
    - expect: The task card appears in the Cancelled column

#### 3.11. Task detail — delete a task

**File:** `tests/board/board-task-delete.spec.ts`

**Steps:**
  1. Sign in, navigate to a board, and open the task detail sheet for a 'Todo' task with no agent assigned
    - expect: A 'Delete task' button is visible at the bottom of the details section
  2. Click 'Delete task'
    - expect: The task detail sheet closes
    - expect: The task card is removed from the board
    - expect: The Todo column count decrements

#### 3.12. Task detail — set priority

**File:** `tests/board/board-task-set-priority.spec.ts`

**Steps:**
  1. Sign in, navigate to a board, and open a task's detail sheet
    - expect: A priority dropdown (Select) is present in the task header area
  2. Open the priority dropdown and select 'urgent'
    - expect: The task card in the board now shows an 'urgent' badge in red/orange styling
    - expect: The dropdown reflects the selected priority 'urgent'

#### 3.13. Board shows loading skeleton while data is fetching

**File:** `tests/board/board-loading-state.spec.ts`

**Steps:**
  1. Sign in and navigate to a board URL with network throttled to slow
    - expect: Pulse-animated skeleton placeholders are shown in 5 column areas before the real data arrives
    - expect: Once data loads, the skeleton is replaced by actual task cards

#### 3.14. Repository filter bar appears when tasks have repositories

**File:** `tests/board/board-repo-filter.spec.ts`

**Steps:**
  1. Sign in and navigate to a board where at least one task has a repository linked
    - expect: A filter bar appears below the header with an 'All repos' button and individual repository buttons
  2. Click a specific repository button in the filter bar
    - expect: Only tasks linked to that repository are shown in the board columns
    - expect: Tasks from other repositories are hidden
  3. Click 'All repos'
    - expect: All tasks are shown again regardless of repository

#### 3.15. Mobile: board renders as single-column with tab switcher

**File:** `tests/board/board-mobile-tabs.spec.ts`

**Steps:**
  1. Sign in and navigate to a board page with the viewport set to a mobile width (e.g. 375px wide)
    - expect: The 5-column desktop grid is hidden
    - expect: A horizontal tab bar shows the 5 column names with task counts
    - expect: Only the first column (Todo) is shown in the content area by default
  2. Click the 'In Progress' tab
    - expect: The In Progress column content is shown
    - expect: The 'In Progress' tab is highlighted with an accent underline

#### 3.16. Onboarding flow — new user with no boards

**File:** `tests/board/board-onboarding-flow.spec.ts`

**Steps:**
  1. Sign in as a user who has no boards, then navigate to /boards/_new or to '/'
    - expect: The Onboarding component is shown (not the board)
    - expect: A centered card displays 'Agent Kanban' and 'Your AI workforce starts here.'
    - expect: Three step indicators are visible, the first is active (accent-colored)
    - expect: A 'Board name' input pre-filled with 'My Board' is shown
    - expect: A 'Create Board' button is present
  2. Clear the board name input and type 'Sprint 1', then click 'Create Board'
    - expect: The stepper advances to step 2
    - expect: A 'First task' input pre-filled with 'First task' appears
    - expect: A 'Create Task' button is visible
  3. Change the task title to 'Setup CI pipeline' and click 'Create Task'
    - expect: The stepper advances to step 3
    - expect: The AddMachineSteps component is shown with installation instructions and an API key

### 4. Header and Navigation

**Seed:** `tests/seed.spec.ts`

#### 4.1. Header renders logo, nav links, theme toggle, and user avatar

**File:** `tests/header/header-elements.spec.ts`

**Steps:**
  1. Sign in and navigate to any protected page (e.g. /settings)
    - expect: The header shows 'Agent Kanban' logo on the left
    - expect: Nav links 'Agents' and 'Machines' are visible on desktop
    - expect: A theme toggle icon button is visible on the right
    - expect: A user avatar button is visible on the right

#### 4.2. Theme toggle cycles through dark, light, system

**File:** `tests/header/header-theme-toggle.spec.ts`

**Steps:**
  1. Sign in and navigate to any page. Note the current theme by inspecting the theme toggle icon.
    - expect: The header is rendered with a theme icon
  2. Click the theme toggle button
    - expect: The theme icon changes to reflect the next theme in the cycle (dark → light → system → dark)
    - expect: The page visually reflects the applied theme
  3. Click the theme toggle button two more times to cycle through all three states
    - expect: After three clicks, the theme icon returns to its original state, completing the full cycle

#### 4.3. User avatar dropdown menu opens

**File:** `tests/header/header-avatar-dropdown.spec.ts`

**Steps:**
  1. Sign in and navigate to any page. Click the user avatar button in the header.
    - expect: A dropdown menu appears showing the user's name or email
    - expect: Menu items include 'Settings', 'Repositories', and 'Sign out'

#### 4.4. Navigate to settings via avatar dropdown

**File:** `tests/header/header-nav-to-settings.spec.ts`

**Steps:**
  1. Sign in, click the user avatar, and then click 'Settings' in the dropdown
    - expect: The user is navigated to /settings
    - expect: The Settings page is displayed with Theme and Boards sections

#### 4.5. Navigate to repositories via avatar dropdown

**File:** `tests/header/header-nav-to-repos.spec.ts`

**Steps:**
  1. Sign in, click the user avatar, and then click 'Repositories' in the dropdown
    - expect: The user is navigated to /repositories
    - expect: The Repositories page is displayed

#### 4.6. Sign out via avatar dropdown

**File:** `tests/header/header-signout.spec.ts`

**Steps:**
  1. Sign in and navigate to any page, then click the user avatar and click 'Sign out'
    - expect: The user is signed out
    - expect: The browser navigates to /auth
    - expect: The sign-in form is displayed

#### 4.7. Board name in header opens board switcher

**File:** `tests/header/header-board-switcher.spec.ts`

**Steps:**
  1. Sign in and navigate to a board page. The header should show 'Agent Kanban / <board name>'.
    - expect: The board name is displayed next to the logo as a ghost button
  2. Click the board name button
    - expect: A 'Switch Board' dialog opens listing all available boards
    - expect: The active board is highlighted with an accent color and a dot indicator
    - expect: A 'New board' option is present at the bottom of the dialog

#### 4.8. Board switcher — create a new board

**File:** `tests/header/header-board-switcher-create.spec.ts`

**Steps:**
  1. Sign in, navigate to a board, open the board switcher dialog
    - expect: Board switcher is open
  2. Click the '+ New board' button
    - expect: An input field and 'Create' button appear in place of the 'New board' button
    - expect: The input is focused
  3. Type 'My New Board' and click 'Create'
    - expect: The dialog closes
    - expect: The header now shows the new board name
    - expect: The browser navigates to the new board's URL

#### 4.9. Board switcher — cancel board creation with Escape

**File:** `tests/header/header-board-switcher-cancel-create.spec.ts`

**Steps:**
  1. Open the board switcher and click 'New board' to show the creation input
    - expect: Create input is visible
  2. Press Escape
    - expect: The create input is hidden
    - expect: The 'New board' button is shown again
    - expect: No board is created

#### 4.10. Agents nav link is highlighted when on agents page

**File:** `tests/header/header-active-nav-link.spec.ts`

**Steps:**
  1. Sign in and navigate to /agents
    - expect: The 'Agents' nav link in the header is highlighted with accent color and accent-soft background
    - expect: The 'Machines' nav link is in the default tertiary color

### 5. Settings Page

**Seed:** `tests/seed.spec.ts`

#### 5.1. Settings page displays theme switcher and boards list

**File:** `tests/settings/settings-page-render.spec.ts`

**Steps:**
  1. Sign in and navigate to /settings
    - expect: Page heading 'Settings' is displayed
    - expect: A 'Theme' section is visible with three buttons: 'light', 'dark', 'system'
    - expect: A 'Boards' section is visible listing all user boards or showing 'No boards yet.' if empty

#### 5.2. Theme switcher — select light theme

**File:** `tests/settings/settings-theme-light.spec.ts`

**Steps:**
  1. Sign in and navigate to /settings
    - expect: Theme buttons are visible
  2. Click the 'light' theme button
    - expect: The 'light' button becomes the active/selected button (shows accent border and accent text)
    - expect: The page applies the light theme visually

#### 5.3. Theme switcher — select dark theme

**File:** `tests/settings/settings-theme-dark.spec.ts`

**Steps:**
  1. Sign in and navigate to /settings. Click the 'dark' theme button.
    - expect: The 'dark' button is highlighted as active
    - expect: The page applies the dark color scheme

#### 5.4. Theme switcher — select system theme

**File:** `tests/settings/settings-theme-system.spec.ts`

**Steps:**
  1. Sign in and navigate to /settings. Click the 'system' theme button.
    - expect: The 'system' button is highlighted as active
    - expect: The theme follows the OS preference

#### 5.5. Board item — expand to edit details

**File:** `tests/settings/settings-board-expand.spec.ts`

**Steps:**
  1. Sign in and navigate to /settings. Verify at least one board is listed.
    - expect: Board items are in collapsed state by default, showing only the board name and an 'Open' link
  2. Click a board item row
    - expect: The board expands showing a Name input, a Description textarea, and a Delete button
    - expect: The chevron icon rotates 90 degrees to indicate expanded state

#### 5.6. Board item — save updated name

**File:** `tests/settings/settings-board-save-name.spec.ts`

**Steps:**
  1. Sign in, navigate to /settings, expand a board item
    - expect: The board Name input shows the current board name
  2. Clear the Name input and type 'Renamed Board'
    - expect: A 'Save' button appears because changes are detected (hasChanges is true)
  3. Click 'Save'
    - expect: The board name updates to 'Renamed Board'
    - expect: The 'Save' button disappears after saving (no pending changes)
    - expect: The board row header shows the new name

#### 5.7. Board item — save button hidden when no changes

**File:** `tests/settings/settings-board-no-changes.spec.ts`

**Steps:**
  1. Sign in, navigate to /settings, and expand a board item
    - expect: No 'Save' button is visible initially because no changes have been made
  2. Change the name field, then revert it back to the original name
    - expect: The 'Save' button disappears again because hasChanges returns to false

#### 5.8. Board item — delete with two-step confirmation

**File:** `tests/settings/settings-board-delete.spec.ts`

**Steps:**
  1. Sign in, navigate to /settings, and expand a board item
    - expect: A 'Delete' button is visible in the expanded area
  2. Click the 'Delete' button
    - expect: The delete button is replaced by 'Delete?', 'Yes', and 'No' inline confirmation options
  3. Click 'No'
    - expect: The confirmation is dismissed and the 'Delete' button is shown again without the board being deleted
  4. Click 'Delete' again, then click 'Yes'
    - expect: The board is deleted
    - expect: The board item disappears from the list

#### 5.9. Board item — Open link navigates to board

**File:** `tests/settings/settings-board-open-link.spec.ts`

**Steps:**
  1. Sign in, navigate to /settings, find a board item in the list
    - expect: An 'Open' link is visible on the right side of the collapsed board row
  2. Click 'Open'
    - expect: The user is navigated to /boards/:boardId
    - expect: The board page for that board is displayed

### 6. Machines Page

**Seed:** `tests/seed.spec.ts`

#### 6.1. Machines page renders correctly with empty state

**File:** `tests/machines/machines-empty-state.spec.ts`

**Steps:**
  1. Sign in as a user with no machines registered and navigate to /machines
    - expect: Page heading 'Machines' is displayed
    - expect: A count of '0 online' is shown
    - expect: An 'Add Machine' button is present
    - expect: The empty state text 'No machines registered.' is shown
    - expect: A link to 'Add Machine' in the empty state text is visible

#### 6.2. Machines page lists machines with status indicators

**File:** `tests/machines/machines-list.spec.ts`

**Steps:**
  1. Sign in as a user with at least one machine registered and navigate to /machines
    - expect: Each machine card shows the machine name, status dot (green for online, gray for offline), OS info if available, session count, active session count, and last heartbeat time
    - expect: The count in the header (e.g. '1 online') reflects the number of online machines

#### 6.3. Open Add Machine dialog

**File:** `tests/machines/machines-add-dialog-open.spec.ts`

**Steps:**
  1. Sign in and navigate to /machines, then click 'Add Machine'
    - expect: A dialog opens with the title 'Add Machine'
    - expect: Two options are presented: 'Your Computer' (enabled) and 'Cloud Sandbox' (disabled/coming soon)
    - expect: The 'Cloud Sandbox' option is visually greyed out with 'Coming soon' text

#### 6.4. Add Machine dialog — choose 'Your Computer' shows setup steps

**File:** `tests/machines/machines-add-local.spec.ts`

**Steps:**
  1. Sign in, navigate to /machines, click 'Add Machine', then click 'Your Computer'
    - expect: The dialog transitions to the 'waiting' step
    - expect: The AddMachineSteps component is displayed
    - expect: Setup instructions with an API key and CLI commands are shown
    - expect: A waiting indicator shows the system is waiting for the machine to connect

#### 6.5. Closing Add Machine dialog before connecting revokes the API key

**File:** `tests/machines/machines-add-dialog-cancel.spec.ts`

**Steps:**
  1. Sign in, open the Add Machine dialog, click 'Your Computer' to generate an API key
    - expect: The dialog shows the AddMachineSteps with an API key displayed
  2. Close the dialog (click outside or press Escape) before the machine connects
    - expect: The dialog closes
    - expect: The generated API key is revoked (an API call to delete the key is made because connected is still false)
    - expect: The machines list does not show a new machine

#### 6.6. Machine list item links to machine detail page

**File:** `tests/machines/machines-list-link.spec.ts`

**Steps:**
  1. Sign in and navigate to /machines. At least one machine must be present.
    - expect: Machine cards are rendered as links
  2. Click on a machine card
    - expect: The browser navigates to /machines/:id
    - expect: The machine detail page is displayed with the machine's name and details

#### 6.7. Machine detail page renders machine information

**File:** `tests/machines/machine-detail-render.spec.ts`

**Steps:**
  1. Sign in and navigate to a machine detail page at /machines/:id
    - expect: A breadcrumb 'Machines / <machine-name>' is displayed
    - expect: Machine name is shown as a heading with a status dot and status label
    - expect: A details card shows OS, Version, Last Heartbeat, and Created date
    - expect: Session count and Active session count are displayed in stat cards
    - expect: A 'Delete' button is visible
    - expect: An 'Agents' section shows agents registered on the machine or 'No agents registered on this machine.'

#### 6.8. Machine detail — offline machine shows reconnect instructions

**File:** `tests/machines/machine-detail-offline.spec.ts`

**Steps:**
  1. Sign in and navigate to the detail page of an offline machine
    - expect: A warning panel 'Machine is offline' is displayed with an amber/warning border
    - expect: A reconnect command is shown: 'ak start --api-url <origin>'

#### 6.9. Machine detail — delete machine with confirmation dialog

**File:** `tests/machines/machine-detail-delete.spec.ts`

**Steps:**
  1. Sign in and navigate to a machine detail page, then click the 'Delete' button
    - expect: A confirmation dialog opens with the title 'Delete Machine'
    - expect: The dialog body mentions the machine name
    - expect: Cancel and 'Delete' (destructive) buttons are shown
  2. Click 'Cancel'
    - expect: The dialog closes without deleting the machine
  3. Click 'Delete' again, then click the red 'Delete' button in the dialog
    - expect: The machine is deleted
    - expect: The user is redirected to /machines

#### 6.10. Machine detail — agent list links to agent detail page

**File:** `tests/machines/machine-detail-agent-link.spec.ts`

**Steps:**
  1. Sign in and navigate to a machine detail page that has at least one agent listed
    - expect: Agent cards show agent name, status dot, and last active time
  2. Click on an agent card in the machine detail view
    - expect: The browser navigates to /agents/:agentId
    - expect: The agent detail page is displayed

#### 6.11. Machine not found shows graceful error state

**File:** `tests/machines/machine-detail-not-found.spec.ts`

**Steps:**
  1. Sign in and navigate to /machines/nonexistent-id
    - expect: The page shows 'Machine not found.' text in the content area
    - expect: The header is still rendered correctly

### 7. Agents Page

**Seed:** `tests/seed.spec.ts`

#### 7.1. Agents page renders empty state when no agents exist

**File:** `tests/agents/agents-empty-state.spec.ts`

**Steps:**
  1. Sign in as a user with no agents and navigate to /agents
    - expect: Heading 'Agents' is displayed
    - expect: A 'New agent' button is visible
    - expect: The text 'No agents yet.' is displayed
    - expect: A 'Create your first agent' link is shown

#### 7.2. Agents page renders agent cards in a grid

**File:** `tests/agents/agents-grid.spec.ts`

**Steps:**
  1. Sign in as a user with at least one agent and navigate to /agents
    - expect: Agents are displayed in a 3-column card grid
    - expect: Each card shows the agent identicon, agent name, fingerprint badge, status indicator, and a stats strip with task count, token count, and cost

#### 7.3. Agent card links to agent detail page

**File:** `tests/agents/agents-card-link.spec.ts`

**Steps:**
  1. Sign in, navigate to /agents, and click on an agent card
    - expect: The browser navigates to /agents/:id
    - expect: The agent detail page is displayed

#### 7.4. 'New agent' button navigates to agent creation page

**File:** `tests/agents/agents-new-button.spec.ts`

**Steps:**
  1. Sign in, navigate to /agents, and click the 'New agent' button
    - expect: The browser navigates to /agents/new
    - expect: The AgentNewPage is displayed with the 'New agent' heading and 'Recruit' and 'Custom' option cards

#### 7.5. Agent creation — choose 'Custom' path goes to form

**File:** `tests/agents/agents-new-custom.spec.ts`

**Steps:**
  1. Sign in and navigate to /agents/new
    - expect: The 'Choose path' step is displayed with 'Recruit' and 'Custom' cards
  2. Click the 'Custom' card
    - expect: The form step is displayed with the heading 'Create agent'
    - expect: Identity fieldset with Name, Role, Bio, Soul inputs is visible
    - expect: Runtime fieldset with Runtime dropdown and Model input is visible
    - expect: Workflow fieldset with 'Handoff to' and 'Skills' fields is visible
    - expect: A live preview card is shown on the right side

#### 7.6. Agent creation — live preview updates as name is typed

**File:** `tests/agents/agents-new-preview.spec.ts`

**Steps:**
  1. Sign in, navigate to /agents/new, click 'Custom', and look at the preview card on the right
    - expect: Preview shows 'Agent' as the placeholder name
  2. Type 'Bolt' in the Name field
    - expect: The preview card name updates to 'Bolt' in real time
    - expect: The identicon and color bar in the preview update to reflect the 'Bolt' key

#### 7.7. Agent creation — 'Create agent' button disabled when name is empty

**File:** `tests/agents/agents-new-disabled-button.spec.ts`

**Steps:**
  1. Sign in, navigate to /agents/new, click 'Custom'
    - expect: The 'Create agent' button is visible
  2. Leave the Name field empty
    - expect: The 'Create agent' button is disabled (cannot be clicked to submit)
  3. Type any name in the Name field
    - expect: The 'Create agent' button becomes enabled

#### 7.8. Agent creation — add a skill tag with Enter key

**File:** `tests/agents/agents-new-skills-tag.spec.ts`

**Steps:**
  1. Sign in, navigate to /agents/new, click 'Custom', scroll to the Skills field in the Workflow section
    - expect: Skills tag input is visible with placeholder text
  2. Click the Skills field, type 'typescript', and press Enter
    - expect: A 'typescript' tag chip appears in the input
    - expect: The text input clears for the next entry
  3. Type 'react' and press Enter
    - expect: A 'react' tag chip also appears
    - expect: Two skill tags are now visible: 'typescript' and 'react'

#### 7.9. Agent creation — remove a skill tag

**File:** `tests/agents/agents-new-skills-remove.spec.ts`

**Steps:**
  1. Sign in, navigate to /agents/new, click 'Custom', add the skill 'python' using the Skills field
    - expect: A 'python' skill tag is shown
  2. Click the '×' button on the 'python' tag chip
    - expect: The 'python' tag is removed from the Skills field

#### 7.10. Agent creation — choose 'Recruit' path shows template grid

**File:** `tests/agents/agents-new-recruit.spec.ts`

**Steps:**
  1. Sign in, navigate to /agents/new, click the 'Recruit' card
    - expect: The 'Recruit an agent' step is shown with the heading and subtitle
    - expect: A grid of agent template cards is loaded (or a loading skeleton is shown during fetch)
    - expect: Each template card shows an identicon, name, and slug badge

#### 7.11. Agent creation — back navigation from form step

**File:** `tests/agents/agents-new-back-from-form.spec.ts`

**Steps:**
  1. Sign in, navigate to /agents/new, click 'Custom' to reach the form step
    - expect: Form step is displayed with a 'Back' button
  2. Click the 'Back' button
    - expect: The user returns to the 'Choose path' step showing 'Recruit' and 'Custom' cards

#### 7.12. Agent detail page renders identity hero

**File:** `tests/agents/agent-detail-render.spec.ts`

**Steps:**
  1. Sign in and navigate to an agent's detail page at /agents/:id
    - expect: A '← Agents' back link is visible
    - expect: The identity hero card shows the agent identicon, agent name, status dot, bio if present, and metadata (runtime, model, created time)
    - expect: A telemetry strip shows TASKS, INPUT, OUTPUT, CACHE, COST stats
    - expect: Tabs for 'Mission', 'Activity', and 'Sessions' are displayed below the hero card

#### 7.13. Agent detail — click fingerprint watermark opens identity modal

**File:** `tests/agents/agent-detail-identity-modal.spec.ts`

**Steps:**
  1. Sign in, navigate to an agent detail page, and click the fingerprint watermark icon on the right side of the hero card
    - expect: The 'Cryptographic Identity' modal opens
    - expect: The modal displays the Fingerprint with a 'Copy' button
    - expect: The modal displays the Ed25519 Public Key with a 'Copy' button
    - expect: A close button (×) is visible in the modal header

#### 7.14. Agent detail — close identity modal

**File:** `tests/agents/agent-detail-identity-modal-close.spec.ts`

**Steps:**
  1. Sign in, navigate to an agent detail page, open the identity modal
    - expect: Identity modal is displayed
  2. Click the '×' close button in the modal header
    - expect: The modal closes
    - expect: The agent detail page is visible behind it

#### 7.15. Agent detail — Mission tab shows active task or 'No active mission'

**File:** `tests/agents/agent-detail-mission-tab.spec.ts`

**Steps:**
  1. Sign in and navigate to an agent that has no active task assigned
    - expect: The Mission tab content shows 'No active mission.'

#### 7.16. Agent detail — Activity tab lists logs or empty state

**File:** `tests/agents/agent-detail-activity-tab.spec.ts`

**Steps:**
  1. Sign in, navigate to an agent detail page, and click the 'Activity' tab
    - expect: If the agent has activity logs, they are displayed as rows with relative time, action label, and task title
    - expect: If no logs exist, the text 'No activity yet.' is displayed

#### 7.17. Agent detail — Sessions tab lists sessions or empty state

**File:** `tests/agents/agent-detail-sessions-tab.spec.ts`

**Steps:**
  1. Sign in, navigate to an agent detail page, and click the 'Sessions' tab
    - expect: If the agent has sessions, they are displayed in a timeline with session ID fragment, status badge, and machine name
    - expect: Active sessions have a pulsing dot
    - expect: If no sessions exist, the text 'No sessions yet.' is displayed

#### 7.18. Agent not found shows graceful error state

**File:** `tests/agents/agent-detail-not-found.spec.ts`

**Steps:**
  1. Sign in and navigate to /agents/nonexistent-id
    - expect: The page shows 'Agent not found.' text in the content area
    - expect: The header is still rendered correctly

### 8. Repositories Page

**Seed:** `tests/seed.spec.ts`

#### 8.1. Repositories page renders empty state with CLI instructions

**File:** `tests/repositories/repos-empty-state.spec.ts`

**Steps:**
  1. Sign in as a user with no repositories and navigate to /repositories
    - expect: Page heading 'Repositories' is displayed with '0 total' count
    - expect: An 'Add Repository' button is present in the header
    - expect: The empty state shows 'No repositories registered.'
    - expect: Instructions mention the 'ak link' CLI command with a code block
    - expect: An 'add manually' link is shown for manual addition

#### 8.2. Repositories page lists repositories with metadata

**File:** `tests/repositories/repos-list.spec.ts`

**Steps:**
  1. Sign in as a user with at least one repository and navigate to /repositories
    - expect: Each repository card shows name, clone URL, task count, and added date
    - expect: The count in the header shows the total number of repositories
    - expect: A 'Remove' button is visible on each repository card

#### 8.3. Open Add Repository dialog

**File:** `tests/repositories/repos-add-dialog-open.spec.ts`

**Steps:**
  1. Sign in, navigate to /repositories, and click 'Add Repository'
    - expect: A modal dialog appears with the title 'Add Repository'
    - expect: A 'Name' input field is present with placeholder 'my-repo'
    - expect: A 'Clone URL' input field is present with placeholder 'https://github.com/user/repo.git'
    - expect: An 'Add Repository' submit button is present
    - expect: A close button (✕) is visible in the dialog header

#### 8.4. Add Repository — submit button disabled when fields are empty

**File:** `tests/repositories/repos-add-validation.spec.ts`

**Steps:**
  1. Sign in, navigate to /repositories, click 'Add Repository' to open the dialog
    - expect: Both Name and Clone URL fields are empty
  2. Observe the 'Add Repository' submit button state
    - expect: The submit button is disabled when either or both fields are empty
  3. Enter 'my-repo' in Name but leave URL empty
    - expect: The submit button remains disabled
  4. Enter a URL in the Clone URL field as well
    - expect: The submit button becomes enabled

#### 8.5. Add Repository — successfully add a new repository

**File:** `tests/repositories/repos-add-success.spec.ts`

**Steps:**
  1. Sign in, navigate to /repositories, and open the Add Repository dialog
    - expect: Dialog is open
  2. Type 'test-repo' in Name and 'https://github.com/user/test-repo.git' in Clone URL, then click 'Add Repository'
    - expect: The dialog closes
    - expect: The new repository 'test-repo' appears at the top of the repositories list
    - expect: The total count in the header increments by 1

#### 8.6. Close Add Repository dialog without submitting

**File:** `tests/repositories/repos-add-dialog-close.spec.ts`

**Steps:**
  1. Sign in, navigate to /repositories, open the Add Repository dialog
    - expect: Dialog is open
  2. Click the '✕' close button in the dialog header
    - expect: The dialog closes without adding a repository
    - expect: The repository list is unchanged
  3. Open the dialog again, type something in the Name field, then click outside the dialog (on the backdrop)
    - expect: The dialog closes without adding a repository

#### 8.7. Remove a repository

**File:** `tests/repositories/repos-remove.spec.ts`

**Steps:**
  1. Sign in, navigate to /repositories with at least one repository present
    - expect: Repository cards are shown, each with a 'Remove' button
  2. Click the 'Remove' button on a repository card
    - expect: The repository card disappears from the list immediately
    - expect: The total count in the header decrements by 1
