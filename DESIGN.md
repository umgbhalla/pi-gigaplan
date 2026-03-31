# Gigaplan TUI Design System

## Principles

1. **Information hierarchy over decoration.** Every pixel of terminal real estate is expensive. No chrome that doesn't communicate state.
2. **Density scales with context.** Footer = 1 metric. Widget = 3-5 metrics. Tool result = structured detail. Overlay = full data.
3. **State is color.** Plan state maps directly to one semantic color. No mixing. No gradients. One color per state, always.
4. **Width-first responsive.** Everything renders correctly at 80 columns. Wider terminals get more metrics, not bigger boxes.
5. **Components, not templates.** Reusable view-model → renderer pipeline. Same data model powers all 5 surfaces.

---

## Color Semantics

Every visual element maps to exactly one `theme.fg()` color. No raw ANSI.

| Role | Theme Color | Used For |
|------|------------|----------|
| **Label** | `dim` | Field names, separators, structural text |
| **Value** | `text` | Primary data values (plan name, step name) |
| **Accent** | `accent` | Active/focused element, next step, commands |
| **Good** | `success` | Passed checks, verified flags, SKIP/done, positive delta |
| **Risk** | `warning` | Open minor flags, CONTINUE, uncertain confidence |
| **Bad** | `error` | Failed checks, significant flags, ABORT, errors |
| **Quiet** | `muted` | Secondary info, counts, metadata |
| **Chrome** | `borderMuted` | Borders, dividers, structural lines |

### State Color Map

Each plan state maps to exactly one color:

| State | Color | Token |
|-------|-------|-------|
| initialized | `accent` | Active, just started |
| clarified | `accent` | Active, progressing |
| planned | `accent` | Active, progressing |
| critiqued | `warning` | Awaiting evaluation |
| evaluated | `warning` | Decision point |
| gated | `success` | Approved, ready |
| executed | `success` | Implemented |
| done | `success` | Complete |
| aborted | `error` | Stopped |

### Recommendation Color Map

| Recommendation | Color |
|---------------|-------|
| SKIP | `success` |
| CONTINUE | `warning` |
| ESCALATE | `warning` + bold |
| ABORT | `error` |

---

## Typography

All rendering is monospace. Hierarchy through color and weight, not size.

| Role | Style | Example |
|------|-------|---------|
| **Title** | `bold(text)` via `theme.bold()` | Plan name, step name |
| **Label** | `fg("dim", text)` | `iter`, `flags`, `eval`, `score` |
| **Value** | `fg("text", text)` or state color | `2`, `SKIP`, `3.5` |
| **Tag** | `fg(stateColor, text)` | `evaluated`, `CONTINUE` |
| **Separator** | `fg("dim", text)` | ` · `, ` → ` |
| **Indicator** | Colored character | `●` significant, `○` minor, `✓` verified |

### Indicators

Consistent single-character indicators throughout the system:

| Symbol | Meaning | Color |
|--------|---------|-------|
| `●` | Significant / active / focused | Context-dependent |
| `○` | Minor / inactive | `dim` |
| `✓` | Passed / verified / addressed | `success` |
| `✗` | Failed / blocked | `error` |
| `!` | Warning / open flag | `warning` |
| `→` | Next / transition | `dim` |
| `↓` | Improving (score decrease) | `success` |
| `↑` | Degrading (score increase) | `error` |

---

## Layout System

### Width Tiers

Content adapts to terminal width. Not by adding boxes — by adding data.

| Width | Tier | Widget Content |
|-------|------|----------------|
| 80-99 | Narrow | Name + state + next step only |
| 100-119 | Medium | + flag summary + eval recommendation |
| 120+ | Wide | + score trend + delta + confidence |

### Spacing Rules

- **Intra-field:** Single space between label and value: `iter 2`
- **Inter-field:** Double space between field groups: `iter 2  flags 3✓ 1!`
- **Section break:** ` · ` (dim) between semantic groups
- **No box borders in widgets.** Borders waste 2 columns per side on already-scarce width. Use color contrast and spacing instead.
- **Box borders only in overlays** where the component floats over content and needs a visual boundary.

---

## Surface Specifications

### Surface 1: Footer Status

**API:** `ctx.ui.setStatus("gigaplan", styledString)`
**Height:** 1 line (part of shared footer bar)
**Priority:** Absolute minimum — plan identity + actionable state.

```
Layout (narrow):
{planName} {stateTag} → {nextStep}

Layout (wide):
{planName} {stateTag} → {nextStep}  iter:{n}  {flagSummary}
```

**Construction:**
```typescript
// Narrow (always)
let s = theme.bold(state.name)
s += " " + theme.fg(stateColor, state.current_state)
s += theme.fg("dim", " → ") + theme.fg("accent", nextStep)

// Wide (when footer has room, check via width param)
s += theme.fg("dim", "  iter:") + theme.fg("text", String(state.iteration))
s += "  " + flagSummary
```

**Updates:** On `session_start`, `session_switch`, and after every gigaplan tool execution.

---

### Surface 2: Widget (Above Editor)

**API:** `ctx.ui.setWidget("gigaplan", (tui, theme) => component)`
**Height:** 1-2 lines content (no border, no padding waste)
**Priority:** Scan-level overview — what, where, how healthy.

**Line 1 — Identity + State:**
```
{indicator} {planName}  {stateTag} → {nextStep}  iter {n}
```

**Line 2 — Metrics (only when relevant data exists):**
```
  flags {verified}✓ {open}!  eval {recommendation} {confidence}  score {prev}→{curr}  delta {pct}
```

**Width Scaling:**
- Under 100 cols: Line 1 only
- 100-119: Line 1 + flags + eval
- 120+: Full line 2

**Multi-plan indicator** (when >1 active plan):
```
{indicator} {planName}  {stateTag} → {nextStep}  (1 of 3 plans)
```

**Construction:**
```typescript
// Line 1
let line1 = theme.fg("accent", "◆") + " " + theme.bold(vm.name)
line1 += "  " + theme.fg(vm.stateColor, vm.state) 
line1 += theme.fg("dim", " → ") + theme.fg("accent", vm.nextStep)
line1 += "  " + theme.fg("dim", "iter ") + theme.fg("text", String(vm.iteration))
if (vm.totalPlans > 1) {
  line1 += "  " + theme.fg("muted", `(1 of ${vm.totalPlans})`)
}

// Line 2 (if data exists and width allows)
let line2 = "  "
line2 += theme.fg("dim", "flags ") + theme.fg("success", vm.verifiedFlags + "✓")
line2 += " " + theme.fg("warning", vm.openFlags + "!")
line2 += "  " + theme.fg("dim", "eval ") + theme.fg(vm.recColor, vm.recommendation)
// ... score, delta when width allows
```

**Renders as:** `string[]` — array of 1 or 2 terminal lines, each truncated to width.

**State transitions:**
- No active plan: widget removed (`setWidget("gigaplan", undefined)`)
- Plan in terminal state (done/aborted): widget removed
- Active plan: widget shown with current state

---

### Surface 3: Tool Renderers

**API:** `renderCall(args, theme, context)` + `renderResult(result, options, theme, context)`
**Priority:** Action-specific detail. Collapsed = summary. Expanded = full picture.

#### renderCall — All tools

One-line call summary. Same pattern for every tool:

```
{toolLabel} {primaryArg}
```

```typescript
// gigaplan_init
theme.fg("toolTitle", theme.bold("gigaplan_init ")) + theme.fg("accent", args.idea.slice(0, 60))

// gigaplan_advance  
theme.fg("toolTitle", theme.bold("gigaplan_advance ")) + theme.fg("accent", args.step)

// gigaplan_status
theme.fg("toolTitle", theme.bold("gigaplan_status")) + (args.planName ? " " + theme.fg("accent", args.planName) : "")

// gigaplan_step
theme.fg("toolTitle", theme.bold("gigaplan_step ")) + theme.fg("accent", args.step)

// gigaplan_doctor
theme.fg("toolTitle", theme.bold("gigaplan_doctor")) + (args.fix ? theme.fg("warning", " --fix") : "")

// gigaplan_override
theme.fg("toolTitle", theme.bold("gigaplan_override ")) + theme.fg("accent", args.action)
```

#### renderResult — Collapsed (default)

One-line result summary. Structure: `{outcome} {step/action} {key metric}`

```typescript
// gigaplan_advance (success)
theme.fg("success", "✓") + " " + theme.fg("text", step) 
  + theme.fg("dim", " · ") + keyMetric

// gigaplan_advance (evaluate)  
theme.fg("success", "✓") + " evaluate"
  + theme.fg("dim", " → ") + theme.fg(recColor, recommendation)
  + " " + theme.fg("dim", confidence)

// gigaplan_advance (gate fail)
theme.fg("error", "✗") + " gate"
  + theme.fg("dim", " · ") + theme.fg("error", failedChecks.join(", "))

// gigaplan_advance (error)
theme.fg("error", "✗") + " " + step
  + theme.fg("dim", " · ") + theme.fg("error", errorSummary)

// gigaplan_doctor
theme.fg(issueCount > 0 ? "warning" : "success", issueCount > 0 ? `${issueCount} issues` : "clean")
  + (fixCount > 0 ? theme.fg("success", ` · ${fixCount} fixed`) : "")

// gigaplan_status
theme.fg("text", planName)
  + " " + theme.fg(stateColor, state)
  + theme.fg("dim", " → ") + theme.fg("accent", nextStep)
```

#### renderResult — Expanded

Multi-line detail. Structure: header line + metric block + detail block.

**gigaplan_advance (step completed):**
```
✓ critique v2                                           3m 28s
  flags  2 new · 3 verified · 0 disputed
  next   evaluate (pure logic)
```

**gigaplan_advance (evaluate):**
```
✓ evaluate → SKIP  medium confidence
  score   3.5 → 1.5 (↓57%)
  flags   1 significant open · 2 minor
  next    gate
```

**gigaplan_advance (gate fail):**
```
✗ gate FAILED
  ✓ project_exists   ✓ project_writable   ✓ plan_exists
  ✓ has_criteria      ✗ no_unresolved_flags (1 significant)
  actions: force-proceed · integrate · add-note
```

**gigaplan_advance (error with recovery):**
```
✗ critique — Step output is not valid JSON
  file    critique_output.json
  issue   markdown fences wrapping JSON
  fix     gigaplan_doctor({ fix: true }) → normalize + retry
```

**gigaplan_status (expanded):**
```
{planName}  {state} → {nextStep}  iter {n}
  flags    {total} total · {verified}✓ · {open}! · {addressed} addressed
  eval     {recommendation} · {confidence} · score {value}
  history  clarify → plan → critique → evaluate → integrate → plan → critique
```

**gigaplan_status (with iteration comparison, when multiple iterations):**
```
{planName}  {state} → {nextStep}  iter {n}

  iter  recommendation  confidence  score  significant  delta
  v1    CONTINUE        high        3.5    2 open       —
  v2    SKIP            medium      1.5    1 open       ↓57%

  v1→v2  3 verified · 2 raised · 2 addressed
  recurring: multi-plan selection semantics
```

#### renderResult — Component Structure

```typescript
renderResult(result, { expanded, isPartial }, theme, context) {
  if (isPartial) return new Text(theme.fg("dim", "Processing..."), 0, 0)
  
  const d = result.details as AdvanceDetails
  
  // Collapsed: single styled line
  let collapsed = d.success 
    ? theme.fg("success", "✓") 
    : theme.fg("error", "✗")
  collapsed += " " + theme.fg("text", d.step) + theme.fg("dim", " · ") + keyMetric(d, theme)
  
  if (!expanded) return new Text(collapsed, 0, 0)
  
  // Expanded: build multi-line string with \n
  let text = collapsed
  text += "\n" + formatMetricBlock(d, theme)
  if (d.flags?.length) text += "\n" + formatFlagBlock(d.flags, theme)
  if (d.nextSteps?.length) text += "\n" + formatNextBlock(d.nextSteps, theme)
  
  return new Text(text, 0, 0)
}
```

---

### Surface 4: Interactive Overlay (Doctor/Recovery)

**API:** `ctx.ui.custom((tui, theme, kb, done) => component, { overlay: true })`
**Components:** `Container` + `DynamicBorder` + `Text` + `SelectList`
**Priority:** Full detail + interactive actions.

**Structure:**
```
─── Gigaplan Doctor ─────────────────────────
  
  {planName}  {state} → {nextStep}
  
  Issues (n):
  ● Malformed JSON in critique_output.json
    markdown fences wrapping valid JSON
  
  > Normalize JSON (strip fences, rewrite)    ← SelectList
    Respawn critique agent
    Abort plan

  ↑↓ navigate · enter select · esc cancel
─────────────────────────────────────────────
```

**Component tree:**
```
Container
  ├── DynamicBorder (top, themed)
  ├── Text (plan identity line, padX=1, padY=0)
  ├── Text (issue list, padX=1, padY=0)
  ├── SelectList (actions, themed)
  ├── Text (keybinding hints, padX=1, padY=0)
  └── DynamicBorder (bottom, themed)
```

**Only used for:**
1. `/gigaplan-doctor` command (interactive mode)
2. Future: iteration comparison inspector (if tool result is too cramped)

---

### Surface 5: Iteration Comparison (in expanded tool result)

Not a separate overlay — lives inside `gigaplan_status` expanded renderResult.

**Renders as plain Text with aligned columns:**
```typescript
// Build aligned table as string
let table = theme.fg("dim", "  iter  rec       conf    score  sig    delta")
for (const row of vm.iterations) {
  table += "\n  " + theme.bold("v" + row.version)
  table += "    " + theme.fg(row.recColor, padRight(row.recommendation, 9))
  table += padRight(row.confidence, 8)
  table += theme.fg(row.scoreColor, padRight(row.score, 7))
  table += theme.fg(row.sigColor, padRight(row.sigFlags, 7))
  table += theme.fg(row.deltaColor, row.delta)
}
```

**Column alignment:** Use `padRight()` with fixed column widths. All values right-padded with spaces. Monospace makes this trivial.

---

## View Model

One shared data structure powers all surfaces. Computed from `planDir` + `PlanState`.

```typescript
interface GigaplanViewModel {
  // Identity
  name: string
  planDir: string
  totalPlans: number          // How many active plans exist
  
  // State
  state: string               // current_state
  stateColor: ThemeColor      // mapped from state
  nextStep: string | null
  iteration: number
  
  // Flags
  totalFlags: number
  verifiedFlags: number
  openSignificant: number
  openMinor: number
  addressedFlags: number
  
  // Evaluation (null if no evaluation yet)
  recommendation: string | null    // SKIP, CONTINUE, ESCALATE, ABORT
  recColor: ThemeColor
  confidence: string | null
  weightedScore: number | null
  
  // Trend (null if iteration < 2)
  prevScore: number | null
  scoreDelta: string | null        // "↓57%" or "↑12%"
  deltaColor: ThemeColor
  
  // History
  stepHistory: string[]            // ["clarify", "plan", "critique", ...]
  lastStepDuration: number | null  // ms
  
  // Iterations (for comparison table)
  iterations: IterationRow[]
  
  // Recovery (null if healthy)
  recovery: RecoveryInfo | null
}

interface IterationRow {
  version: number
  recommendation: string
  recColor: ThemeColor
  confidence: string
  score: string
  scoreColor: ThemeColor
  sigFlags: string
  sigColor: ThemeColor
  delta: string
  deltaColor: ThemeColor
  newFlags: number
  verifiedFlags: number
  addressedFlags: number
}

interface RecoveryInfo {
  failedStep: string | null
  issue: string
  file: string | null
  autoFixAvailable: boolean
  suggestedAction: string
}
```

**Computed once, consumed everywhere.** Footer, widget, tool renderers, and overlay all read from the same view model. No surface computes its own data.

---

## File Structure

```
src/presentation/
  ├── view-model.ts       # buildViewModel(planDir, state, root) → GigaplanViewModel
  ├── format.ts           # Shared formatting: padRight, formatFlags, formatScore, stateColor
  ├── widget.ts           # Widget component (implements Component)
  ├── tool-renderers.ts   # renderCall/renderResult for all 6 tools
  ├── doctor-overlay.ts   # Interactive doctor/recovery overlay
  └── comparison.ts       # buildIterationRows(planDir, state) → IterationRow[]
```

Each file is pure: takes data + theme → returns styled strings or Components. No file reads, no state mutation.
