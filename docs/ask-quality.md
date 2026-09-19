# Ask and retrieval in Mneme 0.2.3

## Root causes and selection

Previously, FTS joined every question token with `OR`, so common words admitted most small-brain memories. Entity matches expanded graph neighbors, and vectors above cosine 0.15 entered reciprocal-rank fusion. Authority, importance, recency and project affinity added rank bonuses. None of these scores established that a memory actually answered the question. The compiler accepted candidates until the token budget was full. Its body-only deduplication could also collapse distinct project records with identical prose.

Candidate retrieval remains broad and hybrid. Ask now has a separate final selection step:

- Remove question filler, normalize common English forms and aliases, and assess weighted coverage of meaningful terms in content, titles, projects, tags and structured facts.
- Treat explicit identifiers and named project scopes as stronger constraints than rank bonuses. Multiple named projects can contribute to comparisons.
- Retrieve project records by metadata for project-status overviews, even when their prose lacks the query words. Broader questions can therefore use more evidence.
- Retain meaningful graph connections when the question actually asks about that relationship; include the directed relationship and reference IDs in evidence. A generic `related_to` edge does not qualify an unrelated memory.
- Retain optional semantic matches using their actual cosine score and proximity to the best match, with lexical corroboration when an exact answer exists. Rank bonuses order qualifying evidence; they cannot independently qualify it.
- Keep competing current facts with the same relevant fact key. A future idea in Inbox does not establish a selected choice when explicit current choice facts exist.
- Apply existing privacy, archival, temporal and supersession exclusions. Deduplicate by content **and** meaningful identity/metadata. Fit the selected evidence to the configured token budget.

There is no universal final source count. The existing bounded candidate window is 200 for Ask; final counts depend on relevance, the question's scope and the context budget. General Search retains its broad discovery behavior. The final selector is deterministic and adds no reranking model call.

Structured fact keys/values now have an FTS column, including readable key components. The derived index upgrades and rebuilds without changing canonical memory or Markdown. New embeddings include facts, project, type and status; existing embeddings remain usable, and can be refreshed through the existing embedding job.

## Metadata and response style

The old evidence serializer omitted `status`, `type`, `memory_class`, `project`, validity and supersession. The model could not see `status=completed`, even though SQLite and the UI had it.

Selected evidence now contains title, type, class, explicit status, project, validity interval, current-state flag, supersedes reference, facts, compact provenance/source identifiers, revision/date, content and applicable graph relationships. It does not include filesystem paths, content hashes or editing controls. Status metadata takes precedence over outdated planning prose.

Streaming and non-streaming Ask share one system prompt. It requests direct answers using “you” and “your,” short recall responses, brief citations, relevant conflicts only, and simple acknowledgment of missing information. It discourages report headings, retrieval/security narration, unrelated missing details and repeated summaries. Untrusted-content and prompt-injection rules remain internal. Empty retrieval produces a short “you haven't recorded…” reply without calling a model.

## Sources, chats and scroll behavior

- Each turn shows **Sources · N**, collapsed by default. Only final evidence appears. Source buttons keep the citation mapping and open the corresponding memory. Candidate lists and diagnostic IDs are not sent to the chat or saved as source dependencies.
- **New chat** creates a fresh durable conversation scope. Earlier chats stay available in the history selector. It changes no memories, projects, events or indexes, and requires no destructive confirmation. Existing per-turn archival remains separate.
- Migration 5 assigns old turns to the legacy conversation and adds a durable active-chat pointer. New Chat survives restart. An in-flight request from a previous chat cannot attach itself to the new one. Switching is blocked while the current answer is running.
- Turns use insertion order, including when timestamps tie. Questions append at the bottom and their answers stream directly below them. Following begins on submission, pauses when you scroll upward, and resumes near the bottom or with **Jump to latest**. Source expansion does not trigger a scroll effect. Stable turn keys preserve source expansion across history refreshes.
- Chats group durable history; each question continues to use fresh memory retrieval. Previous model answers are not silently reused as factual evidence. The UI shows the latest 100 turns in a chat; earlier turns remain stored and available through the paged history API.

## Targeted verification

All tests used disposable brains. No personal memories or project data were changed during testing.

38 distinct backend tests passed across Ask quality (6), retrieval (10), provider/privacy/jobs (7), API/stream shutdown (2), lifecycle (5), and archival compatibility (8). Two browser tests passed, including a 37-turn conversation with substantial scrolling, timestamp ties, streamed output, manual upward scrolling, Jump to latest, collapsed sources, memory inspection, New Chat and restart.

New tests cover deliberately unrelated memories, project comparisons, explicit graph evidence, Project B's completed metadata, identical-prose projects, exact structured prices, real current conflicts, missing facts, private/archived/expired/superseded exclusions, legacy-chat migration, and source dependencies during permanent deletion.

### Selection diagnostics

Fixture: 13 memories spanning active/completed projects, hardware, purchasing policy, a future idea, a technical goal and unrelated notes.

| Question                           | Candidates | Final evidence | Selected context tokens | Context if all candidates were included |
| ---------------------------------- | ---------: | -------------: | ----------------------: | --------------------------------------: |
| What is FORGELINE and its purpose? |         13 |              3 |                     539 |                                   2,190 |
| Active and completed projects?     |         12 |              3 |                     566 |                                   1,949 |
| Hardware configuration?            |         13 |              1 |                     203 |                                   2,104 |
| Is AWS Architecture completed?     |         13 |              1 |                     230 |                                   2,106 |
| Test GPU maximum price?            |         13 |              1 |                     210 |                                   2,104 |
| Unrecorded telescope password?     |         13 |              0 |                      47 |                                   2,105 |

These are the application's byte-based token estimates, not tokenizer measurements. The comparison uses the same current serializer before/after final selection, not a claimed historical latency benchmark. Selected context is about 71–90% smaller for the answering cases. The shared system prompt adds about 1,027 estimated tokens; actual full prompts in this fixture are about 1,230–1,593 tokens. Empty retrieval makes no model request.

### Real local model checks

Ollama `qwen3.5:9b` streamed grounded replies with thinking disabled. It correctly identified active/completed projects, the Ryzen/64 GB/RTX hardware, AWS completion despite planning prose, and the `1450 EUR` price. A missing fact returned immediately without generation. Two conflicting motor facts produced an explicit conflict with valid citations. The final conflict check selected two sources from five candidates.

Observed local response times were approximately 11.8–24.7 seconds, depending on question, cache state and answer length. This is measured latency, not a controlled speedup claim. `qwen3-embedding:0.6b` was also exercised against all disposable fixture memories: the semantic GPU-price query still selected only the purchasing policy (15 candidates, one final source). Cloud consent, Local Only, model separation, streaming deadlines and cancellation remain covered by targeted tests.

Raw reproducible run records are in `artifacts/ask-quality-diagnostics.json`, `artifacts/ask-quality-ollama.json`, `artifacts/ask-quality-style.json` and `artifacts/ask-quality-conflict.json`. Run `npx tsx scripts/verify-ask-quality.ts --diagnostics` without model calls; omit the flag for the full disposable Ollama check.

## Remaining limits

Selection uses English-oriented lexical rules and conservative semantic thresholds, not a trained relevance model. Unusual paraphrases, very large candidate sets or undocumented aliases can still miss relevant material; exact names, filters and optional embeddings help. Token budgets can constrain broad synthesis. General graph adjacency alone is intentionally insufficient evidence. Model wording remains probabilistic: the local model sometimes adds an unnecessary sentence, though tested replies no longer use generic evidence-analysis sections. Multi-turn pronoun resolution is unchanged; name the subject when a follow-up would otherwise be ambiguous.
