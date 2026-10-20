# Automatic note processing

New notes queue one durable `noteProcessing` row in the same transaction as the
note and its attachments. `NoteProcessingJob` claims it with a lease and token.
`runNoteProcessing` saves each transcription before running the selected stages.

| Mode | Stages | Plain model text |
| --- | --- | --- |
| `comment` | comment | One comment |
| `tags` | tags | Parsed into tag relations, no body mutation |
| `both` | comment, tags | Comment + tags (the UI labels this explicitly) |
| `smartEdit` | smartEdit | Replacement body of the existing note |
| `smartEditTags` | smartEdit, tags | Replacement body, then independent tags |
| `custom` | custom | Determined by `aiCustomAction` |

For a voice diary, select **Smart Edit + Tags**, put the editing instructions in
**Smart Edit Prompt**, and the tagging instructions in **Tags Prompt**. The old
comment prompt is deliberately not reused as an editing prompt.

Custom actions are `replace`, `comment`, or `tools` (default for existing config).
`replace` deterministically saves plain text as the body and offers only the
staged update tool. `comment` saves plain text as a comment. `tools` executes
staged local actions; a response without an action fails retryably instead of
guessing that a comment was requested. Choose `replace` for reliable automatic
custom editing, including models that return plain text instead of tool calls.

Editing uses a dedicated system instruction and only the note-scoped update
tool. If the tool is called, its last staged replacement wins; accompanying
response text is ignored. Without a tool call, the response is the replacement.
Empty results fail. There is no edit-to-comment fallback.

The store writes only `notes.content`, preserving attachments, metadata and tag
relations. Before each change it saves the previous content to `noteHistory`.
The processing checkpoint also retains the source transcript. Neither is
appended to the visible body. The prompt may explicitly request a visible copy.
Tagging uses existing tag paths, canonicalizes their spelling and creates real
relations. A custom tag prompt controls the requested count; the default remains
five. Independent tags survive subsequent manual text edits and are displayed
separately from Markdown.

Effects and stage checkpoints commit in one transaction. AI writes bypass the
note-creation router, so they cannot enqueue recursive post-processing. A
concurrent content change aborts the stage before its effects are saved; retry
uses the latest content. Completed stages are skipped on retry. Expired/replaced
tokens cannot commit effects.

Set `NOTE_PROCESSING_DEBUG=1` for phase, mode, note ID, tools, response action and
mutation diagnostics. Logs omit note text, transcripts and credentials.

## Regression checks

From `server`, run `bun run test:note-processing` for the focused regression suite.

Run these in separate processes because Bun module mocks are process-global:

```sh
bun test server/__tests__/unit/aiServer/noteProcessing.pipeline.test.ts server/__tests__/unit/aiServer/noteProcessing.tags.test.ts shared/lib/__tests__/hashtags.test.ts
bun test server/__tests__/integration/aiServer/noteProcessing.openai.test.ts
bun test server/aiServer/providers/__tests__/litellm-provider.test.ts
```

The pipeline suite runs the real coordinator, model adapter and store with a
mocked database/provider. The OpenAI integration suite runs real Mastra and the
OpenAI SDK against deterministic completion responses, both content-only and
tool calls. It does not require or claim validation against a live Ollama model.

## Historical evidence for mode semantics

The local Git history was inspected without checking out or modifying old trees:

- `c76381e205a3288af29155fa547755bd54bc34cb` (2025-03-17),
  `fix: automated AI tagging #552`, introduced `comment`, `tags` and `both` in
  `src/components/BlinkoSettings/AiSetting.tsx` and `src/server/plugins/ai.ts`.
  At introduction, `both` unequivocally meant comment plus tags; Smart Edit did
  not yet exist.
- `1d12409e10e016f9ab7ec6b0cc749c59a6b195c5` (2025-03-28),
  `feat: add AI post-processing features and update configurations`, added
  `if (processingMode === 'smartEdit' || processingMode === 'both')` after the
  existing comment/tag branches. It also unconditionally saved the smart-edit
  response with `prisma.comments.create`, even when tools had performed an edit.
  The commit message describes adding Smart Edit but gives no rationale for
  adding a third action to Both or for the extra comment. Whether that expansion
  was intentional cannot be established from the message alone.
- `bb66ab40fb552478bbbc122afc868422c4ab31b1` (2025-07-19),
  `feat: More Flexible AI Feature Selection, add custom ai process #743`, added
  Custom as a separate tools path. It did not redefine Both.
- `2b40078e7a013128c27f9492258ec7e925ab9889` (2026-09-13),
  `fix(ai): coordinate audio transcription before post-processing`, transferred
  all three Both stages to the durable worker and introduced both the plain-text
  comment fallback and the visible-transcript preservation check. Its stated
  goal was ordered, durable processing and preservation of concurrent edits.

This supports restoring Both to its original comment-plus-tags meaning and
keeping Smart Edit + Tags as an explicit separate choice. No further runtime
changes were made as a result of this historical investigation.

## File inventory

- `server/aiServer/noteProcessing.ts`: deterministic stage selection.
- `server/aiServer/processingModels.ts`: mode-specific agents and result actions.
- `server/aiServer/aiModelFactory.ts`: tag output contract and global-prompt fallback.
- `server/aiServer/tagProcessing.ts`: canonical tags, inline-tag preservation and tag-only line handling.
- `server/jobs/noteProcessingJob.ts`: history-backed replacement and relational tagging.
- `server/routerTrpc/note.ts`: preserve independent tags on manual saves.
- `server/routerTrpc/noteProcessing.ts`: snapshot the custom result action.
- `shared/lib/types.ts`: optional custom result-action configuration.
- `app/src/components/BlinkoSettings/AiSetting/AiPostProcessingSection.tsx`: combined mode and custom result-action controls.
- `app/src/components/BlinkoCard/noteContent.tsx`: display independent tags.
- `app/src/components/BlinkoCard/cardBlogBox.tsx`: filter tag chips by relation ID.
- `app/public/locales/en/translation.json` and `app/public/locales/de/translation.json`: setting labels and help.
- `server/__tests__/unit/aiServer/noteProcessing.pipeline.test.ts`: pipeline/storage regressions.
- `server/__tests__/unit/aiServer/noteProcessing.tags.test.ts`: tag regressions.
- `server/__tests__/integration/aiServer/noteProcessing.openai.test.ts`: real SDK response handling.
- `server/package.json`: focused regression test command.
- This document: behavior and verification instructions.

Validation in the Windows workspace: 36 focused tests passed; existing LiteLLM,
audio-recorder and file-upload checks also passed. Changed TypeScript files passed
syntax/transpilation checks, translation JSON parsed and `git diff --check` passed.
Full typechecks did not complete (initial heap exhaustion; increased-limit runs
stopped after combined memory exceeded 23 GB). Backend/frontend builds were
blocked by esbuild access errors on ancestor directories. Docker was unavailable,
so live database/model deployment validation remains outstanding.
