# pi-cyber-compact-fallback

A [pi](https://github.com/earendil-works/pi) extension that keeps a session from getting stuck when the upstream provider refuses the compaction summary with a content-policy error.

Normally, when pi compacts the context it sends the conversation to your model and asks for a summary. If that request is rejected by a content filter — for example an upstream code such as `cyber_policy` — the compaction fails, the context is never reduced, and every later attempt hits the same refusal. The usual workaround is to switch the session to a different model, run `/compact` by hand, and switch back.

This extension does that automatically, using a model you configure.

```
compaction fails with a policy refusal
  ├─ manual / threshold  → wait for the session to go idle, then compact again
  │                        with the configured model
  └─ overflow            → submit the summary at the settle boundary so the
                           aborted turn continues in the same run
```

## Requirements

- pi `0.99.x` (developed and tested against `0.99.1`)
- Node 22.18+ or 24+ (the extension is loaded as TypeScript source, no build step)
- No third-party dependencies: only pi's own injected packages and Node built-ins

## Install

```bash
# from a local checkout
pi install /path/to/pi-cyber-compact-fallback

# from git
pi install git:github.com/525300887039/pi-cyber-compact-fallback

# from npm, once published
pi install npm:pi-cyber-compact-fallback
```

Or point pi at the entry file directly:

```bash
pi --extension /path/to/pi-cyber-compact-fallback/extensions/index.ts
```

## Configure

Two files are read, and the project one wins key by key:

| Layer | Path |
|---|---|
| global | `<agent-dir>/cyber-compact-fallback.json` |
| project | `<cwd>/.pi/cyber-compact-fallback.json` |

`<agent-dir>` is `~/.pi/agent` unless `PI_CODING_AGENT_DIR` says otherwise; that variable may itself be `~`, `~/…` (or `~\…` on Windows) and is expanded the same way pi expands it.

Both files are re-read every time they are needed, so **editing the model takes effect on the next compaction** — no restart.

Minimal config:

```json
{
  "fallbackProvider": "your-provider",
  "fallbackModel": "your-model"
}
```

All options:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `fallbackProvider` | string | — | Provider id of the fallback model. Required, otherwise only a warning is shown. |
| `fallbackModel` | string | — | Model id of the fallback model. Required. |
| `autoRetry` | boolean | `true` | Master switch. `false` disables the extension entirely. |
| `patterns` | string[] | see below | Regex sources matched against the failure message. **Replaces** the defaults, never merges. |
| `caseInsensitive` | boolean | `true` | Compile `patterns` with the `i` flag. |
| `thinkingLevel` | string | unset | One of `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Unset means the provider default. |
| `maxSummaryTokens` | number | `8192` | Output cap for the summary request. |
| `maxConversationChars` | number | `400000` | Safety cap on the serialized conversation; the middle is elided. |
| `idleTimeoutMs` | number | `120000` | How long to wait for the session to go idle before giving up. Also bounds how long an overflow retry stays armed, and the deadline for each fallback summary request: a request still running when it passes is abandoned and no compaction is written. Values above `2147483647` ms (~24.8 days) are capped to that limit with a warning, because Node's `setTimeout` would otherwise treat them as 1 ms. |
| `promptTemplate` | string \| null | `null` | Replaces the built-in summary prompt. Supports `{conversation}`, `{previousSummary}` and `{customInstructions}`. Substitution is a single pass: values are inserted verbatim, so a literal `{previousSummary}` inside the conversation is not replaced again. |

Default patterns:

```json
[
  "cyber_policy",
  "content[\\s_-]?policy",
  "content[\\s_-]?filter",
  "policy[\\s_-]?violation",
  "safety[\\s_-]?(block|refus|filter)",
  "model\\s+refused",
  "provider\\s+stopped with:\\s*sensitive"
]
```

The last two cover pi-ai's Anthropic adapter, which turns the `refusal` and `sensitive` stop reasons into `The model refused to complete the request` and `Provider stopped with: sensitive`. They are deliberately narrow: a bare `refus`/`sensitive` would also fire on `connection refused` and `sensitive file`, which are not policy refusals.

## What triggers a retry, and what does not

Detection is **positive matching on policy vocabulary only**. Status codes are deliberately ignored, because `400` is also what context-length and malformed-request errors return.

| Failure | Retried? |
|---|---|
| `... upstream code: cyber_policy ...` | yes |
| `content policy violation`, `safety filter`, `policy_violation` | yes |
| `The model refused to complete the request` (Anthropic `refusal`) | yes |
| `Provider stopped with: sensitive` (Anthropic `sensitive`) | yes |
| `terminated`, `socket closed`, `ETIMEDOUT`, `ECONNRESET` | no |
| `connection refused`, `ECONNREFUSED` | no |
| `401`, `invalid api key`, `unauthorized` | no |
| `context_length_exceeded`, `maximum context length` | no |
| user pressed Esc / compaction cancelled | no |

When Anthropic sends its own refusal explanation, pi uses that text instead of `The model refused to complete the request`, so the default patterns cannot match it — add the provider's wording to `patterns` yourself.

## Behaviour

- **At most one retry.** A failure of the fallback compaction itself is terminal: you get an error notification and nothing else is queued.
- **No stickiness.** The retry applies to one compaction only. The next compaction goes back to pi's default model, even in the same session.
- **The default summarizer is never used as a second fallback.** If the fallback model also fails, the compaction is cancelled rather than handed back to pi — sending the same conversation to the same refusing upstream would fail identically.
- **`/compact <instructions>` is preserved.** The retry reuses the instructions from the original command.
- **Overflow keeps its retry semantics when pi allows it.** When pi aborts a turn to recover from a context overflow, the fallback summary is submitted as a compaction entry at the `agent_before_settle` boundary with `continue: true`, so the aborted turn runs again in the same loop — you do not have to resend anything. When pi reports that the context cannot continue, the summary is still applied (so the next turn is no longer over the limit) but the turn is not re-run, and you are told to resend.
- **An overflow refusal supersedes a queued retry.** If a manual/threshold retry is still waiting for the session to go idle when overflow recovery is refused too, the extension switches to the settle-boundary path and uses that overflow attempt's preparation instead of compacting again later.
- **`autoRetry` is honoured live.** It is re-read before a queued retry fires, before an armed compaction sends its request, and before the settle boundary submits. Setting it to `false` cancels those pending actions instead of handing the compaction back to pi's default summarizer; changing `fallbackModel` before the request is sent takes effect.
- **The fallback request is provider-neutral.** It goes through `ModelRegistry.streamSimple(...).result()`, the same simple-stream path pi uses for routing, so a virtual/routed model works like it does in the main session and `thinkingLevel` is passed as the request's `reasoning` level. There is no separate `complete()` code path.
- **Every fallback request has a deadline.** `idleTimeoutMs` also bounds a single summary request. A request still running when the deadline passes is abandoned — no compaction entry is written, and an answer that arrives afterwards is discarded. This keeps a model call that ignores cancellation from stalling the run.
- **A cancelled run drops its boundary arm.** When a run is cancelled before `agent_before_settle`, `agent_settled` releases the armed overflow retry and its preparation, so stale state cannot leak into the next run. A queued manual/threshold retry survives.

## Limitations

- **Esc during an overflow fallback summary is not instant.** pi 0.99.x does not give extensions an abort signal at the settle boundary (`ctx.signal` is `undefined` there), and this extension does not touch pi's key handling. Pressing Esc therefore does not cancel that summary immediately; the request is bounded by `idleTimeoutMs` instead, the handler gives up at the deadline, and a late answer is never committed. A summary that finishes before the deadline is still written as a compaction entry — pi only suppresses the automatic continuation after Esc. A manual compaction does receive pi's signal and is cancelled promptly.
- **A resend may still be needed after an overflow.** pi decides whether the aborted turn can be resumed; when it says no, the context is repaired but you have to resend your last message. The extension tells you when this happens.
- **File lists are not accumulated across rounds.** pi collects read/modified files for its own summaries and carries them forward; a summary produced by this extension reports them in `details` instead, so the next default compaction starts that list fresh.
- **State is per-process.** A `/reload` mid-retry drops a queued retry. Nothing is persisted except the summary that lands in the session.
- **Other compaction extensions may conflict.** `agent_before_settle` handlers replace the accumulated `entries` array; this extension appends to what is already there, but two extensions both producing compaction summaries will fight.
- Retrying is not a way around a provider's policy. It moves the summarization to a model you chose; if that model refuses too, compaction still fails.

## Disable

Set `"autoRetry": false`, delete the config file (no fallback model configured means no retry), or uninstall the extension.

## Development

```bash
node --test test/*.test.ts
```

- `test/detector.test.ts` — failure classification
- `test/summarize.test.ts` — prompt assembly and the fallback model call
- `test/config.test.ts` — layer merging and validation
- `test/state.test.ts` — the retry state machine
- `test/extension.test.ts` — the handlers, driven through a fake pi and context

No build step: `extensions/index.ts` is loaded as-is, and the source is plain erasable TypeScript.

## Layout

```
extensions/index.ts   hook registration and the two recovery paths
src/detector.ts       failure classification (pure)
src/config.ts         config loading and validation (pure)
src/state.ts          retry state machine (pure)
src/summarize.ts      prompt assembly and the fallback model call
```

## License

MIT
