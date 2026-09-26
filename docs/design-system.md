# Design system

The visual center is the user's graph. All visible nodes, edges, history, retrieval highlights and counts come from stored state. Test fixtures are isolated and labeled.

## Foundations

Tokens live in `ui/tokens.css`; shared rules in `ui/styles.css`.

| Role         | Treatment                                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Canvas       | Deep blue-black `#090f1a`, subtle spatial grid, no idle redraw loop                                                     |
| Surfaces     | `#111a29` hierarchy, restrained transparency and blurred overlays                                                       |
| Primary text | `#c0ccdf`, headings `#e0e7f3`, muted text `#7c91ae`                                                                     |
| Accent       | Soft lavender `#bcb4ef`; reserved for focus, selected state and main actions                                            |
| Typography   | Local Segoe UI Variable/system UI; Cascadia Code/Consolas for identifiers and source text; no font downloads            |
| Scale        | 12 px minimum supporting text at Default, 13–15 px body, 24–36 px page headings, larger empty-state display             |
| Spacing      | Predominantly 4/8/12/16/24/32 px; consistent row baselines and pane padding                                             |
| Corners      | Tight controls, softer dialogs; large plain surfaces remain spatial rather than stacks of cards                         |
| Icons        | Lucide, usually 14–18 px; larger only in empty states                                                                   |
| Motion       | Brief opacity/translation transitions; 420 ms eased graph focus; interruptible camera movement; reduced-motion override |
| Focus        | Visible keyboard focus, explicit accessible names, native dialog focus containment, accessible graph entity list        |

## Reusable behavior

Shared primitives include `Modal`, `Empty`, `Tag`, `Markdown`, icon buttons, primary actions, form stacks, segmented navigation, inline errors and toasts. All source rendering passes through the same sanitization boundary. The editor retains unsaved work on errors and confirms closing a changed draft.

## Graph language

- Stable seeded layout grouped by stored entity type, with bounded collision relaxation.
- Distant zoom shows counted clusters; closer zoom reveals entities, then labels and relationship types.
- Selected nodes gain a ring and brighter label; real neighbors remain prominent while unrelated nodes fade.
- Retrieved nodes and connecting stored edges illuminate. No inferred path is invented for presentation.
- Inferred nodes use a diamond; inferred edges use a dashed line, supplementing color.
- Historical view uses the requested timestamp and a clear historical label.
- Label priority favors focus and retrieval, suppressing collisions on other nodes.

## Review record

Two visual passes examined empty and populated graph, note list/editor/preview, inspector tabs, command palette, search, Ask with evidence, timeline, projects, inbox, tasks, sources, backups, diagnostics and narrow layouts. Corrected compact navigation labels, select labels, capture sizing, text excerpts, initial graph framing and transient screenshot timing. Automated screenshots are regenerated under `artifacts/screenshots/`; synthetic populated graphs are labeled test data. The 350-node profiling screenshot is a stress fixture, not user knowledge.

## Text preferences

All CSS pixel font sizes use shared `--text-*` tokens. Compact uses 0.93×, Default 1×, and Large 1.16×; dimensions and browser zoom are unchanged. Settings persist `text_size` and `graph_labels` in the brain’s local settings file. Canvas labels use the same preset factors. The graph key explains stored relationship labels, direction and provenance; node labels are collision-limited and capped by viewport area.
