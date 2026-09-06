# Accessibility Review — Foundry web UI

Snapshot review of every `web/src/components` file present at review time
(ChatColumn, AgentTimeline, Workspace, CodeViewer, BuildsHistory, PlanView,
QuestionCard, SetupCard, Logo). Line numbers refer to that snapshot; other
agents are editing these files, so treat them as approximate and match on the
quoted code.

Severity: HIGH = broken keyboard or screen-reader path, MED = missing
semantics/announcement, LOW = polish.

New shared hooks in `web/src/a11y.ts` (useRovingTabindex, useFocusTrap,
useFocusReturn, useEscape) are referenced by several fixes below.

## Punch list

1. HIGH — `ChatColumn.tsx:57` (`<div className="messages" ...>`): the
   conversation is a plain overflowing div, so keyboard users cannot scroll
   it. Fix: add `tabIndex={0}` to that element (it already has an accessible
   name via `aria-label="Conversation"`).

2. MED — `ChatColumn.tsx:57`: a bare `aria-live="polite"` div is used as the
   chat feed. Fix: add `role="log"` to the same element — the correct role for
   an append-only feed, and it implies polite live announcements.

3. MED — `ChatColumn.tsx:92-106`: the "Ctrl+Enter to send" hint is not
   programmatically associated with the composer textarea. Fix: put
   `id="composer-hint"` on the hint span and
   `aria-describedby="composer-hint"` on the textarea.

4. HIGH — `ChatColumn.tsx:88` (`{children}` slot): inline decision cards
   (QuestionCard, PlanView) mount inside the feed with no focus move and no
   announcement, so keyboard/screen-reader users can miss that the build is
   waiting on them. Fix: when such a card mounts, move focus into it (card
   container with `tabIndex={-1}` + `.focus()`, or its first control). See
   items 18 and 19 for the card-side half of this fix.

5. HIGH — `AgentTimeline.tsx:159` (`<div className="file-feed" ...>`):
   scrollable file feed is not keyboard-focusable. Fix: add `tabIndex={0}`.

6. MED — `AgentTimeline.tsx:178-180`: review-issue severity is conveyed only
   by color and an `aria-hidden` badge glyph; screen readers hear just the
   issue text. Fix: on `.issue-badge` remove `aria-hidden` and use
   `role="img"` + `aria-label={issue.severity}`.

7. LOW — `AgentTimeline.tsx:99-100`: `aria-controls="timeline-body"` points
   at an element that only exists while the section is open. Valid per ARIA,
   but rendering the body with the `hidden` attribute instead of unmounting
   keeps the reference always resolvable.

8. HIGH — `Workspace.tsx:258-305` with `:69-76`: when a build completes, the
   "Build complete" summary card overlays the preview with no announcement,
   while focus is sent to the Preview tab (`:74`). Fix: give `.done-card`
   `tabIndex={-1}`, focus it on mount instead of the preview tab, and let
   dismissing it ("Open Preview") move focus naturally. Its primary action
   then sits one Tab away.

9. LOW — `Workspace.tsx:78-84`: the tablist handles ArrowLeft/ArrowRight but
   not Home/End (recommended by the tabs pattern). Fix: map `Home`/`End` to
   the first/last tab in `onTabKeyDown`.

10. LOW — `Workspace.tsx:86-94`: the "Loading build..." empty state is silent
    for screen readers. Fix: add `role="status"` to that empty-state div.

11. HIGH — `CodeViewer.tsx:100-114`: every file button sits in the tab order,
    so a build with many files makes Tab unusable, and there is no arrow-key
    navigation. Fix: apply roving tabindex — `useRovingTabindex` from
    `../a11y` (orientation "vertical"): spread `containerProps` on the `<ul>`
    and `getItemProps(i)` on each file button.

12. MED — `CodeViewer.tsx:128-135`: copy feedback ("Copied" / "Copy failed")
    is only a button-label change, which screen readers do not reliably
    announce. Fix: add `aria-live="polite"` to the Copy button (or render the
    feedback in a separate `role="status"` element).

13. MED — `BuildsHistory.tsx:78,110-130`: the popup is announced as a listbox
    (`aria-haspopup="listbox"`, `role="option"`), but the items perform
    navigation — that is the menu pattern, not a selectable listbox. Fix:
    `aria-haspopup="menu"` on the toggle, `role="menu"` on the `<ul>`,
    `role="menuitem"` on each button, drop `aria-selected`, and put
    `aria-current="true"` on the button for the open build.

14. MED — `BuildsHistory.tsx:84-85`: opening the panel leaves focus on the
    toggle with no indication a menu appeared. Fix: when the panel opens,
    focus its first item (or the panel itself with `tabIndex={-1}`).

15. LOW (refactor, not a bug) — `BuildsHistory.tsx:24-59`: hand-rolled
    Escape-to-close, focus-return-to-toggle and arrow-key navigation can now
    be replaced with `useEscape`, `useFocusReturn` and `useRovingTabindex`
    from `../a11y`.

16. MED — `PlanView.tsx:88-90`: in read-only mode a step's done state is only
    a CSS class plus an `aria-hidden` check glyph; screen readers hear just
    the title. Fix: on `.step-static-check` drop `aria-hidden` and use
    `role="img"` + `aria-label={step.done ? 'done' : 'not done'}`.

17. HIGH — `PlanView.tsx:34-36,74-84`: clicking a step's remove button
    unmounts the focused element, so focus falls to `<body>` and keyboard
    users lose their place. Fix: after `removeStep(i)`, focus the remove
    button now at index `i` (or the previous one at the list end); keep item
    refs or use `useFocusReturn`-style restore against the section container.

18. MED — `PlanView.tsx` (card level): the card appears in the chat feed
    without focus or announcement. Fix: when `editable` and mounted, focus the
    first step-title input or the Approve button. Card-side half of item 4.

19. MED — `QuestionCard.tsx` (card level): same appearance problem — the card
    mounts silently. Fix: on mount, focus the first suggested-answer button if
    `question.options.length > 0`, otherwise the freeform input. Card-side
    half of item 4.

20. MED — `SetupCard.tsx:91-100`: when the card is shown dynamically (e.g.
    missing provider config), focus stays wherever it was and the close
    button / form go unnoticed. Fix: focus the Provider select on mount (or
    the section with `tabIndex={-1}`).

## No issues found

- `Logo.tsx` — decorative SVG correctly uses `aria-hidden` + `focusable={false}`.
- `index.html` has `lang="en"`; `styles.css:57` defines a `:focus-visible`
  outline. Both verified.
- Icon-only buttons across Workspace/SetupCard/BuildsHistory all carry
  `aria-label`; the device-width segmented control uses `aria-pressed`
  correctly; tab/panel wiring (`aria-selected`, `aria-controls`, `hidden`) in
  Workspace is correct.

## Cross-cutting notes for the integrator

- There is no `.visually-hidden` utility class in `styles.css` (POLISH-owned).
  Fixes above deliberately avoid needing one, but future work will want:
  `.visually-hidden { position:absolute; width:1px; height:1px; margin:-1px;
  padding:0; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap;
  border:0; }`
- No skip-to-content link exists at the app shell level (App.tsx — outside
  this review's scope; flag for the integrator).
- The new UI landing in this wave (visual editor, console tab, checkpoints,
  share) should adopt `web/src/a11y.ts` hooks from the start: useFocusTrap +
  useFocusReturn + useEscape for any modal/drawer, useRovingTabindex for
  toolbars, lists and menus.
