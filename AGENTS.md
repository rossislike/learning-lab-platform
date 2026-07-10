# Repository Agent Instructions

## Completion Workflow

- Before committing a completed task, spawn two independent sub-agents as adversarial reviewers of the full in-scope change. The primary agent must choose the strongest suitable available model for each reviewer when the runtime supports model selection. If model selection is unavailable, use the runtime default and note that limitation in the completion report.
- Give both reviewers the task requirements and ask them to inspect correctness, regressions, security, maintainability, missing tests, and instruction compliance without editing files.
- Continue only after both reviewers return usable reports. After both reviews finish, spawn a separate fixer sub-agent with both review reports. The fixer must validate each finding, apply every valid in-scope fix, reject invalid findings explicitly, and run focused verification for its edits.
- Continue only after the fixer completes successfully. The primary agent must review the fixer result, run final verification, and only then commit the completed task.
- If a required sub-agent is unavailable, times out, returns an unusable report, or the fixer fails, do not commit until the user explicitly approves proceeding without the complete review workflow.
- If the primary agent makes a substantive in-scope edit after the fixer finishes, restart the two-reviewer and fixer workflow against the updated change. Verification-only actions do not restart the workflow.
- After completing and verifying a task, commit all in-scope changes to the repository before reporting completion.
- Keep each commit focused on the completed task and exclude unrelated user changes.
