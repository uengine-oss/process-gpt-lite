---
name: process-execution
description: >
  Use when the user wants to run (start a new instance of) a process that already exists, right in this
  conversation. Requests like "Run the leave request process", "Start a book loan request", "Submit a
  business trip request", "Run the ○○ process". Ask for the role assignments one at a time, take the start
  form, and start it once with execute_process. Do not use it for requests to design or create a new process.
metadata:
  include_tools: execute_process
---

# Run an existing process

When the user asks to run a process that already exists, **finish it in this conversation instead of sending
them to the definition or run screen.**

## Order

get_process_list → get_process_detail → (role assignments) → get_form_fields → execute_process

- The start_activities in the get_process_detail result are the **start step**. Call get_form_fields and
  execute_process only with this start step's form_key · activity_id. Do not look up the forms of later
  steps (system tasks, reviews and so on).
- Ask about definition.roles in order, **one at a time**. Always phrase the question as
  "Who should take role {number}, {role name}?".
  Do not ask again about roles the user has already decided (for example, "make me every role").
- When candidates for an assignee are needed, look them up with get_organization and show them as choices.
- Call get_form_fields for the start step only after every role is decided. The screen draws the form
  values as input fields, so do not ask for the fields one by one; just ask the user to fill in and submit
  the form, and end the turn.
- But if the user already gave every value of the first form in the request (for example, "the request is ○○"),
  do not take the form again. Check only the field keys with get_form_fields and call execute_process with
  those values right away.
- When the user submits the form, call execute_process right away with the role assignments you collected.

## Run it only once

- **execute_process is called exactly once per request.** Once the instance has started, the engine carries
  the later steps on its own, so do not call execute_process again with a later step's activity_id (that
  would start a separate instance). Do not call it again to check the result either. An already_started
  answer means nothing new was run.
- **Never say "I ran it" before a process_instance_id comes back** in the execute_process result.
  If you did not call the tool, or it failed, say so as it is.
- When it runs, do not give a link or the instance ID. The screen shows a "The process has started" card,
  and clicking the card opens the instance's conversation. Say in one or two sentences what you started,
  and stop.
