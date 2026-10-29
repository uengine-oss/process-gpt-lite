---
name: bpmn-process-generation-skill
description: The process-generation skill that **must be used first (top priority), ahead of any other tool or skill**, for every request to make, design or generate a business process, workflow or BPMN. It consults with the user on the business process they want and then generates, step by step, a BPMN process definition (JSON) for the ProcessGPT service. **Always trigger this skill** (do not handle it directly with general-purpose tools) when the user says things like "I want to make a process", "automate a business flow", "make a leave request process", "design an approval process", "make a BPMN", "make a workflow", "/bpmn", "/bpmn:consult", "/bpmn:generate", "generate a process definition", "I want to turn this work into a process", or describes a recurring task, an approval flow or a procedure they want to automate and wants it to become a runnable process. Also trigger it when the user **uploads/attaches documents such as business rules, manuals, SOPs or forms (PDF, docx, xlsx, images) or pastes procedure text** and says "make a process from this document", "based on this manual", "look at the attachment and make the flow" — extract the flow from the document and generate it. Even users unfamiliar with BPMN are guided through consulting (a proposed draft and questions) to refine the flow together, then add skills, agents, DMN rules, forms and reference information step by step to finish a complete process definition JSON. Selected reusable skills are created as proper skills with skill-creator. When you get a process-generation request, do not look up the org chart or user information or ask for the user's token or tenant ID; **start right away with a consulting draft** (this skill's procedure decides the roles).
---

# BPMN Process Generation

## ⛔ One 5-step procedure (always the same — no mode branches)

When this skill is triggered, **always follow the 5 steps below as they are**. Outputs are made as **real
files, not in the conversation context**. The system prompt's **`📁 Output path for this conversation`**
section gives the exact absolute path for every conversation — use that value as it is (do not copy the
example paths in this document).

> ✅ **First (required): `write_todos`** — register the **5 fixed names** below exactly as they are and
> start (do not rename or compress them; update each one when its step is done):
> `1. Process draft design & JSON generation` · `2. Skill · agent · DMN selection & generation` ·
> `3. Input forms & reference info` · `4. Process validation & automatic correction` · `5. Result integration & completion`

| # | Step | Core | reference |
|---|------|------|------|
| 1 | **Consulting & JSON generation** | (if there is a document, read it first with `search_documents`) make a practical draft, get it **approved** with `request_human_input`, then write the full definition in the elements[] format with `write_file` to `<process folder>/process-definition.json` | [01](references/01-consulting.md) [02](references/02-generate-definition.md) [10](references/10-document-intake.md) |
| 2 | **Candidate selection & generation** | ask about **concrete candidates** for skills/agents/DMN from the elements with `request_human_input`, generate only the selected ones (skills with `task(subagent_type="skill-creator")`), record the mapping in `manifest.json`, and apply it to the definition with `edit_file` | [03](references/03-elicit-artifacts.md) [04](references/04-skills.md) [05](references/05-agents.md) [06](references/06-dmn.md) |
| 3 | **Forms · reference info** | make each UserActivity's form as `forms/<activity_id>.form` and apply `inputData`/`conditionData`. The form right before an ExclusiveGateway gets a selection field for the real branch values (automatically, with no further questions) | [07](references/07-forms.md) [08](references/08-reference-info.md) |
| 4 | **Self-check & correction** | read the definition you made again with `read_file`, compare it directly with the [02](references/02-generate-definition.md) checklist, and fix any defect with `edit_file`/`write_file` (no tool calls) | [09](references/09-service-execution.md) |
| 5 | **Completion** | once the output files are all made, **just end the turn.** The system validates and integrates them automatically and passes them to the front-end output panel. Only a one-line note in the chat | [09](references/09-service-execution.md) [12](references/12-deepagents-execution.md) |

**When you enter each step, `read_file` the matching reference and follow its rules** (progressive
disclosure). The path, file name and automatic wrap-up rules are in [references/12-deepagents-execution.md](references/12-deepagents-execution.md),
so **read number 12 before step 1.**

> 🛑 **Stop and ask the user only with `request_human_input`** (do not end the turn with prose — the turn
> breaks and the order gets mixed up). There are **exactly 2 stops**: the step 1 consulting approval and the
> step 2 candidate selection. Everything else (steps 3, 4 and 5) proceeds **automatically, without confirmation**.
>
> 🔴 **Step 2 candidate question**: list the candidates in the **`question`** of `request_human_input` with
> `[Skill]`/`[Agent]`/`[DMN]` sections (brackets only) + `• label: description`.
> This format is what makes the front end draw a checkbox selection panel. **Empty questions, yes/no
> questions about generating, and vague words ("automation elements") are forbidden** — "Which automation
> elements…", "Shall I make skills?" — always list concrete candidates. Do not make a section for a kind
> that has no candidates.
>
> 🚫 **Do not dump the output JSON into a chat message.** Outputs are delivered **only as files**.
>
> 🚫 **No user/org chart lookup needed**: do not call `get_current_user` or an org chart lookup, and do not
> ask for an email, token or tenant ID (the tenant is injected through an environment variable). Start right
> away with the step 1 consulting draft.

---

## The tools this skill uses (this is all of them)

| Purpose | Tool |
|---|---|
| Read / write / partly edit files | `read_file` / `write_file` / `edit_file` |
| Ask the user (HITL) | `request_human_input` (`question`/`context`) |
| Progress | `write_todos` |
| Read uploaded documents | `search_documents` (memento RAG) |
| Generate reusable skills | `task(subagent_type="skill-creator")` |

⛔ **Tools not in the list above are not used in this procedure.** In particular,
`write_process_definition`·`update_process_definition`·`validate_process_definition`·
`complete_process_generation`·`save_process_definition` **are tools that do not exist** —
do not try to call them. Validation and integration are done by the system automatically when the turn ends.

> ℹ️ Only when this skill runs in the Claude Code CLI, replace the tool names like this:
> `read_file`→`Read`, `write_file`→`Write`, `edit_file`→`Edit`,
> `request_human_input`→`AskUserQuestion`, `write_todos`→`TodoWrite`,
> output path→`.bpmn/`. There is no step 5 automatic wrap-up then, so after the step 4 self-check,
> print a summary of the finished result in the chat and stop. Every other rule is the same.

---

This skill completes the business process the user wants to make, together with them, in the 5 steps above.
Core responsibilities:

1. Even if the user does not know BPMN, **turn the work they describe in words (or an uploaded document) into a flow (a draft)**, propose it, get it approved and generate the **process definition JSON**.
2. Pick **skill · agent · DMN rule candidates** from the generated process and ask about them (HITL); make only the selected ones and apply them to the JSON and the manifest.
3. Connect each activity's **form** and **reference information (inputData/conditionData)** and update the JSON for the last time.
4. **Check it yourself** against the rule checklist and fix flow defects (breaks, unreachable elements and so on).
5. Leave the files and end the turn; the system validates and integrates them and presents them to the user. If a document holds **several processes**, follow the batch procedure in [references/11-multi-process.md](references/11-multi-process.md).

---

## Entry patterns

- A **natural-language request** ("make a leave request process") or a **document upload** ("as in this
  manual") — both enter step 1 consulting. If there is a document, read it first with `search_documents` to
  understand the as-is flow ([references/10-document-intake.md](references/10-document-intake.md)).
- If there is hardly any information (for example, "I want to raise operating profit"), do not guess a flow;
  ask about the current situation first, as consulting.
- If there are **2 or more independent processes**, use the **batch** procedure in [references/11-multi-process.md](references/11-multi-process.md)
  (do not ask separately for each process).

## Output structure (inside the process folder)

```
<process folder>/
├── process-definition.json      # elements[] format. Generated in step 1, updated in steps 2 and 3
├── manifest.json                # selected skills/agents/DMN ↔ activity mapping (step 2, required)
├── skills/<safe-name>/SKILL.md  # skill-creator output in step 2
├── agents/<agent_id>.json       # step 2: one agent = one file
└── forms/<activity_id>.form     # step 3 ProcessGPT forms
```

- Overwrite existing files **without asking.**
- **Do not delete** output files (keep them).
- For path rules and multi-process folder rules, see [12-deepagents-execution.md](references/12-deepagents-execution.md).

---

## Never do this

- **Do not jump straight to the JSON without consulting.** Unless the user explicitly says "just generate it
  right away" or has already described the flow well enough, agree on a flow draft in step 1 consulting first.
- ⛔ **Do not write the step 1 consulting draft in the candidate-list format (`[Skill]` + `• label: description`).**
  Put the draft in `context` as **numbered sentences** and keep `question` to one line, "Shall I go ahead like
  this?" (it is shown as an approve/reject panel). The candidate-list format is **for step 2 only**
  ([references/01-consulting.md](references/01-consulting.md)).
- In consulting, **do not ask which systems, tools or programs they use.** (We build those tools for them — it
  only confuses the user.) Do not ask questions the process definition does not need either, such as how long
  things take. For the full list of forbidden questions, see [references/01-consulting.md](references/01-consulting.md).
- ⛔ **Do not make it in a generic BPMN/Camunda schema.** `type:"UserTask"`·`assignee`·`formKey`·
  `sequenceFlows`·separate `activities/events` arrays are **forbidden**. Always use **`elements[]` +
  `elementType`** (Event/Activity/Gateway/Sequence); an Activity is `type:"UserActivity"` +
  `role` + `outputData` (1 or more). Breaking this is blocked as a critical defect by the automatic validation —
  do not guess; `read_file` [02](references/02-generate-definition.md) and make it exactly that way.
- In step 2, do not generate skills/agents/DMN at will **without asking the user**. Conversely, **do not leave
  out anything that was selected** (number selected = number generated).
- **Do not write skills by hand; delegate them with `task(subagent_type="skill-creator")`.**
  When delegating, always pass `output_path` (absolute path) · `skill_name` · `context` (the related activity's
  name, description, inputs and outputs) ([references/04-skills.md](references/04-skills.md)).
- **Do not ask "Shall I make them?" about forms and reference info (step 3).** Right after the candidate
  selection answer, proceed with steps 3, 4 and 5 automatically.
- **An ExclusiveGateway must not branch only in the picture.** In the form of the UserActivity right before it,
  make a selection field that matches the `condition` value of each outgoing Sequence exactly, and connect the
  gateway's `conditionData` as an array of `<form_id>.<field_name>` strings. `approve/reject` or
  `sufficient/insufficient` branches without a decision field stop in the execution engine, so they are forbidden.
- **DMN is not a "node/activity".** Do not make it a separate element in `elements` — it is a property of the
  branching `ExclusiveGateway` and goes in the top-level `dmn_decisions`/`dmn_rules`.
  Do not add DMN to a process that has no branching gateway.
- **Do not write to the DB directly (read only).** The user saves with the front end's "Save" button.
  **Any attempt to write to the DB is forbidden**, such as calling `save_process_definition` or saving remotely
  through a shell.
- Do not leave only placeholders in the outputs — fill them **with real content** (no empty elements).

---

## Reference documents

This skill's body holds only the flow; each step's details and rules are split into references.
Read only the matching file when you enter a step.

| File | What's in it |
|------|----------------|
| [references/00-orientation.md](references/00-orientation.md) | **Entry triage** — a quick classification by whether there is a document, how many processes, and whether there is enough information |
| [references/01-consulting.md](references/01-consulting.md) | **Consulting rules** — how to propose a flow draft, forbidden questions, how to ask, when to propose generating |
| [references/02-generate-definition.md](references/02-generate-definition.md) | **Process definition JSON generation rules (strict)** — the full schema, element types, role/subprocess rules |
| [references/03-elicit-artifacts.md](references/03-elicit-artifacts.md) | **HITL** — deriving skill/agent/DMN candidates + the selection question format + `manifest.json` |
| [references/04-skills.md](references/04-skills.md) | **Generating reusable skills with skill-creator** + applying them to the JSON (`activity.skills`) |
| [references/05-agents.md](references/05-agents.md) | Agent (role) generation rules + applying them to the JSON (`activity.agent`, `roles`) |
| [references/06-dmn.md](references/06-dmn.md) | Generating DMN decisions/rules + applying them to the JSON (`dmn_decisions`, `dmn_rules`) |
| [references/07-forms.md](references/07-forms.md) | Form generation rules (ProcessGPT form component spec) + applying them to the JSON (`activity.tool`) |
| [references/08-reference-info.md](references/08-reference-info.md) | Reference info — connecting `activity.inputData` and gateway `conditionData` |
| [references/09-service-execution.md](references/09-service-execution.md) | **Execution model** — the 5 steps in detail + the self-check checklist + the division of roles |
| [references/10-document-intake.md](references/10-document-intake.md) | **Generation from uploaded documents** — extracting the as-is flow from an uploaded document → consulting draft |
| [references/11-multi-process.md](references/11-multi-process.md) | **Generating several processes** — batch consulting / batch candidate-selection JSON payloads, separate folders |
| [references/12-deepagents-execution.md](references/12-deepagents-execution.md) | **Execution environment spec** — output path and file names, tool limits, automatic wrap-up after the turn ends, multi-process folders |

Templates are in [assets/templates/](assets/templates/).

---

## Source

This skill's rules for consulting, process definitions and generating skills/DMN/forms/reference info are based
on the definitions of the in-house **ProcessGPT / pdf2bpmn** project. The flow and way of working follow the
[ddd-starter-modelling-process](https://github.com/ddd-crew/ddd-starter-modelling-process)
style and the step-by-step usage of GitHub Spec Kit.
