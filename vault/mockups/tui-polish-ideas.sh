#!/usr/bin/env zsh
# TUI Polish Ideas — Powerline & Nerd Font Enhancements for Wrap
#
# Visual mockups for enhancing Wrap's terminal UI using Powerline Extra
# Symbols (https://github.com/ryanoasis/powerline-extra-symbols) and
# Nerd Font icons. Run this script in a Nerd Font terminal to preview.
#
# All enhancements are nerd-font-only — when nerdFonts is disabled,
# fall back to existing glyphs via resolveIcon() / isNerdFonts().
#
# Sections:
#   A. Wizard breadcrumbs (replaces badge, progressive reveal)
#   B. Narrow terminal fallback (dots + compact breadcrumbs)
#   C. Risk badges as curve pills
#   D. Bottom border status pill + action bar in pill
#   E. Key hint pill keycaps
#   F. Spinner in pill in bottom border
#   G. Checklist cursor as curve pill
#   H. Checkbox icon alternatives
#   I. Recommended model pill badge
#   J. Disclaimer warning banner
#   K. Wizard completion screen with config summary
#   L. Plan label pill
#   M. Command fold indicator pill
#   O. Answer mode source pill (stderr chrome)
#   P. Token/cost pills
#   Q. Rate limit retry countdown
#   R. Nested/compound pills (design pattern, no specific use yet)
#   S. Full wizard composite
#   T. Full response dialog composite
#
# Requires: Nerd Font terminal (e.g. FiraCode Nerd Font, JetBrains Mono Nerd)

# --- Powerline glyphs ---
PL_RIGHT=$'\uE0B0'
PL_LEFT=$'\uE0B2'
PL_RCURVE=$'\uE0B4'
PL_LCURVE=$'\uE0B6'
PL_RFLAME=$'\uE0C0'
PL_LFLAME=$'\uE0C1'
PL_RTHIN=$'\uE0B1'
PL_LTHIN=$'\uE0B3'

# Nerd font icons
ICON_CHECK=$'\uF00C'
ICON_GEAR=$'\uF013'
ICON_KEY=$'\uF084'
ICON_LIST=$'\uF03A'
ICON_WARN=$'\uF071'
ICON_STAR=$'\uF005'
ICON_CUBE=$'\uF1B2'
ICON_BOLT=$'\uF0E7'
ICON_ANTHRO=$'\uE754'
ICON_OPENAI=$'\uDB80\uDD04'
ICON_ROUTER=$'\uEA63'
ICON_OLLAMA=$'\uDB80\uDD9A'
ICON_CIRCLE=$'\uF111'        # filled circle
ICON_CIRCLE_O=$'\uF10C'      # empty circle
ICON_DOT=$'\uF444'           # dot circle
ICON_TOGGLE_ON=$'\uF205'     # toggle on
ICON_TOGGLE_OFF=$'\uF204'    # toggle off
ICON_MOON=$'\uF186'
ICON_SUN=$'\uF185'
ICON_PULSE=$'\uF21E'         # heartbeat
ICON_SYNC=$'\uF021'          # refresh
ICON_CLOCK=$'\uF017'
ICON_HOURGLASS=$'\uF254'
ICON_SPINNER=$'\uF110'       # spinner icon
ICON_COG=$'\uF013'
ICON_WRENCH=$'\uF0AD'
ICON_MAGIC=$'\uF0D0'         # magic wand
ICON_DIAMOND=$'\uF219'
ICON_CHECKBOX=$'\uF046'      # checked checkbox
ICON_SQUARE_O=$'\uF096'      # empty checkbox
ICON_PLAY=$'\uF04B'
ICON_ARROW_R=$'\uF061'

# --- Colors ---
RESET=$'\033[0m'
BOLD=$'\033[1m'
DIM=$'\033[2m'

BG_DARK=$'\033[48;2;30;30;50m'
BG_BLUE=$'\033[48;2;40;50;120m'
BG_BADGE=$'\033[48;2;80;60;180m'
BG_ACTIVE=$'\033[48;2;60;80;160m'
BG_DONE=$'\033[48;2;40;90;60m'
BG_PENDING=$'\033[48;2;50;50;80m'
BG_MID=$'\033[48;2;50;50;90m'
BG_TEAL=$'\033[48;2;25;70;60m'
BG_RED=$'\033[48;2;80;25;25m'
BG_ORANGE=$'\033[48;2;80;50;20m'
BG_INPUT=$'\033[48;2;35;35;50m'
BG_CURSOR=$'\033[48;2;26;42;77m'
BG_WIZARD=$'\033[48;2;30;50;90m'

FG_WHITE=$'\033[38;2;210;210;225m'
FG_DIM=$'\033[38;2;100;100;140m'
FG_GREEN=$'\033[38;2;102;204;136m'
FG_BLUE=$'\033[38;2;102;153;255m'
FG_BADGE=$'\033[38;2;80;60;180m'
FG_BADGE_TEXT=$'\033[38;2;220;210;255m'
FG_DARK=$'\033[38;2;30;30;50m'
FG_ACTIVE=$'\033[38;2;60;80;160m'
FG_DONE=$'\033[38;2;40;90;60m'
FG_PENDING=$'\033[38;2;50;50;80m'
FG_MID=$'\033[38;2;50;50;90m'
FG_DONE_TEXT=$'\033[38;2;130;220;160m'
FG_ACTIVE_TEXT=$'\033[38;2;180;200;255m'
FG_PENDING_TEXT=$'\033[38;2;100;100;140m'
FG_TEAL=$'\033[38;2;80;220;200m'
FG_TEAL_BG=$'\033[38;2;25;70;60m'
FG_RED=$'\033[38;2;255;100;100m'
FG_RED_BG=$'\033[38;2;80;25;25m'
FG_ORANGE=$'\033[38;2;255;200;80m'
FG_ORANGE_BG=$'\033[38;2;80;50;20m'
FG_GOLD=$'\033[38;2;245;200;100m'
FG_PINK=$'\033[38;2;255;100;200m'
FG_INPUT=$'\033[38;2;35;35;50m'
FG_WIZARD=$'\033[38;2;30;50;90m'

header() {
  print ""
  print "${BOLD}${FG_BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  print "${BOLD}${FG_BLUE}  $1${RESET}"
  print "${BOLD}${FG_BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  print ""
}

# ════════════════════════════════════════════════════════════════
#  WIZARD
# ════════════════════════════════════════════════════════════════

header "A. WIZARD BREADCRUMBS — Top of Dialog"
print "  Replaces the 🧙 badge in the wizard's top border with breadcrumbs."
print "  Left-aligned: curve pill on left (🧙 Setup Wizard), flame separators"
print "  between steps. Only completed + current step shown — future steps"
print "  hidden so the trail grows as the user advances. Each completed step"
print "  shows ✓ + its icon. Response dialog keeps existing badge (risk pill)."
print "  FILES: border.ts, config-wizard-dialog.tsx, wizard/state.ts"
print ""

print "  ${DIM}Step 1 — Providers (first screen, nothing completed):${RESET}"
dashes=$(printf '─%.0s' {1..58})
print "  ${FG_BLUE}╭${dashes}╮${RESET}"
print -n "  ${FG_BLUE}│${RESET}"
print -n "${FG_WIZARD}${PL_LCURVE}${BG_WIZARD}${FG_WHITE}${BOLD} 🧙 Setup Wizard ${RESET}"
print -n "${FG_WIZARD}${BG_ACTIVE}${PL_RFLAME}${RESET}"
print -n "${BG_ACTIVE}${FG_ACTIVE_TEXT}${BOLD} ${ICON_LIST} Providers ${RESET}"
print "${FG_ACTIVE}${PL_RFLAME}${RESET}                              ${FG_DIM}│${RESET}"
print "  ${FG_BLUE}│${RESET}                                                          ${FG_DIM}│${RESET}"
print ""

print "  ${DIM}Step 2 — API Key (Providers done):${RESET}"
print "  ${FG_BLUE}╭${dashes}╮${RESET}"
print -n "  ${FG_BLUE}│${RESET}"
print -n "${FG_WIZARD}${PL_LCURVE}${BG_WIZARD}${FG_WHITE}${BOLD} 🧙 Setup Wizard ${RESET}"
print -n "${FG_WIZARD}${BG_DONE}${PL_RFLAME}${RESET}"
print -n "${BG_DONE}${FG_DONE_TEXT} ${ICON_CHECK} ${ICON_LIST} Providers ${RESET}"
print -n "${FG_DONE}${BG_ACTIVE}${PL_RFLAME}${RESET}"
print -n "${BG_ACTIVE}${FG_ACTIVE_TEXT}${BOLD} ${ICON_KEY} API Key ${RESET}"
print "${FG_ACTIVE}${PL_RFLAME}${RESET}            ${FG_DIM}│${RESET}"
print "  ${FG_BLUE}│${RESET}                                                          ${FG_DIM}│${RESET}"
print ""

print "  ${DIM}Step 3 — Model (Providers + API Key done):${RESET}"
print "  ${FG_BLUE}╭${dashes}╮${RESET}"
print -n "  ${FG_BLUE}│${RESET}"
print -n "${FG_WIZARD}${PL_LCURVE}${BG_WIZARD}${FG_WHITE}${BOLD} 🧙 Setup Wizard ${RESET}"
print -n "${FG_WIZARD}${BG_DONE}${PL_RFLAME}${RESET}"
print -n "${BG_DONE}${FG_DONE_TEXT} ${ICON_CHECK} ${ICON_LIST} Providers ${RESET}"
print -n "${FG_DONE}${BG_DONE}${PL_RFLAME}${RESET}"
print -n "${BG_DONE}${FG_DONE_TEXT} ${ICON_CHECK} ${ICON_KEY} API Key ${RESET}"
print -n "${FG_DONE}${BG_ACTIVE}${PL_RFLAME}${RESET}"
print -n "${BG_ACTIVE}${FG_ACTIVE_TEXT}${BOLD} ${ICON_CUBE} Model ${RESET}"
print "${FG_ACTIVE}${PL_RFLAME}${RESET}  ${FG_DIM}│${RESET}"
print "  ${FG_BLUE}│${RESET}                                                          ${FG_DIM}│${RESET}"
print ""

print "  ${DIM}Step 4 — Default (all prior done):${RESET}"
print "  ${FG_BLUE}╭${dashes}╮${RESET}"
print -n "  ${FG_BLUE}│${RESET}"
print -n "${FG_WIZARD}${PL_LCURVE}${BG_WIZARD}${FG_WHITE}${BOLD} 🧙 Setup Wizard ${RESET}"
print -n "${FG_WIZARD}${BG_DONE}${PL_RFLAME}${RESET}"
print -n "${BG_DONE}${FG_DONE_TEXT} ${ICON_CHECK} ${ICON_LIST} Providers ${RESET}"
print -n "${FG_DONE}${BG_DONE}${PL_RFLAME}${RESET}"
print -n "${BG_DONE}${FG_DONE_TEXT} ${ICON_CHECK} ${ICON_KEY} API Key ${RESET}"
print -n "${FG_DONE}${BG_DONE}${PL_RFLAME}${RESET}"
print -n "${BG_DONE}${FG_DONE_TEXT} ${ICON_CHECK} ${ICON_CUBE} Model ${RESET}"
print -n "${FG_DONE}${BG_ACTIVE}${PL_RFLAME}${RESET}"
print "${BG_ACTIVE}${FG_ACTIVE_TEXT}${BOLD} ${ICON_STAR} Default ${RESET}${FG_ACTIVE}${PL_RFLAME}${RESET}${FG_DIM}│${RESET}"
print "  ${FG_BLUE}│${RESET}                                                          ${FG_DIM}│${RESET}"

# ────────────────────────────────────────────────────────────────
header "B. NARROW TERMINAL BREADCRUMBS — Compact Dots + Icons"
print "  Fallback when terminal is too narrow for the full breadcrumbs (A)."
print "  Two options: filled/empty dot circles, or icon breadcrumbs with"
print "  thin powerline separators (E0B1). Both show step position compactly."
print ""

print "  ${DIM}Dot breadcrumbs (current = step 3):${RESET}"
print "  ${FG_GREEN}${ICON_CIRCLE}${RESET} ${FG_GREEN}${ICON_CIRCLE}${RESET} ${FG_BLUE}${BOLD}${ICON_CIRCLE}${RESET} ${FG_DIM}${ICON_CIRCLE_O}${RESET}  ${FG_ACTIVE_TEXT}Model${RESET}"
print ""

print "  ${DIM}Icon breadcrumbs (current = API Key):${RESET}"
print -n "  "
print -n "${FG_GREEN}${ICON_CHECK}${RESET}"
print -n " ${FG_DIM}${PL_RTHIN}${RESET} "
print -n "${FG_BLUE}${BOLD}${ICON_KEY} API Key${RESET}"
print -n " ${FG_DIM}${PL_RTHIN}${RESET} "
print -n "${FG_DIM}${ICON_CUBE}${RESET}"
print -n " ${FG_DIM}${PL_RTHIN}${RESET} "
print "${FG_DIM}${ICON_STAR}${RESET}"
print ""

print "  ${DIM}Icon breadcrumbs (current = Model):${RESET}"
print -n "  "
print -n "${FG_GREEN}${ICON_CHECK}${RESET}"
print -n " ${FG_DIM}${PL_RTHIN}${RESET} "
print -n "${FG_GREEN}${ICON_CHECK}${RESET}"
print -n " ${FG_DIM}${PL_RTHIN}${RESET} "
print -n "${FG_BLUE}${BOLD}${ICON_CUBE} Model${RESET}"
print -n " ${FG_DIM}${PL_RTHIN}${RESET} "
print "${FG_DIM}${ICON_STAR}${RESET}"

# ════════════════════════════════════════════════════════════════
#  DIALOG CHROME
# ════════════════════════════════════════════════════════════════

header "C. RISK BADGES — Curve Pill"
print "  Response dialog badge (✔ low risk / ⚠ medium risk / ⚠ high risk)"
print "  wrapped in curve pills (E0B6/E0B4) instead of bare colored text."
print "  Currently badge sits in top border as plain text with bg color."
print "  FILE: border.ts topBorderSegments() — add curve glyphs around badge"
print ""

dashes5=$(printf '─%.0s' {1..44})
print "  ${DIM}Low risk:${RESET}"
print "  ${FG_TEAL}╭${dashes5}${FG_TEAL_BG}${PL_LCURVE}${BG_TEAL}${FG_GREEN}${BOLD} ${ICON_CHECK} low risk ${RESET}${FG_TEAL_BG}${PL_RCURVE}${FG_DIM}─╮${RESET}"
print ""
print "  ${DIM}Medium risk:${RESET}"
print "  ${FG_PINK}╭${dashes5}${FG_ORANGE_BG}${PL_LCURVE}${BG_ORANGE}${FG_ORANGE}${BOLD} ${ICON_WARN} medium risk ${RESET}${FG_ORANGE_BG}${PL_RCURVE}${FG_DIM}╮${RESET}"
print ""
print "  ${DIM}High risk:${RESET}"
print "  ${FG_RED}╭${dashes5}${FG_RED_BG}${PL_LCURVE}${BG_RED}${FG_RED}${BOLD} ${ICON_WARN} high risk ${RESET}${FG_RED_BG}${PL_RCURVE}${FG_DIM}──╮${RESET}"

# ────────────────────────────────────────────────────────────────
header "D. BOTTOM STATUS — Curve Pill"
print "  Bottom border status text (spinner, key hints, action bar) wrapped"
print "  in curve pill. For the response dialog action bar (No/Yes │ Describe"
print "  Edit Follow-up Copy), the selected item gets an inner curve pill"
print "  with brighter bg for clear visibility. Preserves existing hotkey"
print "  underlines, color scheme (#f5c864 primary, #aaaac3 secondary),"
print "  and │ separator between primary/secondary groups."
print "  FILE: border.ts bottomBorderSegments(), response-dialog.tsx ActionBar"
print ""

print "  ${DIM}Keybinding hints (wizard):${RESET}"
print "  ${FG_DIM}╰──${FG_MID}${PL_LCURVE}${BG_MID}${FG_WHITE} ↑↓ navigate  Space toggle  ⏎ confirm ${RESET}${FG_MID}${PL_RCURVE}${FG_DIM}──╯${RESET}"
print ""

print "  ${DIM}Spinner status:${RESET}"
print "  ${FG_DIM}╰──${FG_ACTIVE}${PL_LCURVE}${BG_ACTIVE}${FG_ACTIVE_TEXT} ⢎  Loading models… ${RESET}${FG_ACTIVE}${PL_RCURVE}${FG_DIM}──────────────────────────╯${RESET}"
print ""

print "  ${DIM}Processing follow-up:${RESET}"
print "  ${FG_DIM}╰──${FG_ACTIVE}${PL_LCURVE}${BG_ACTIVE}${FG_ACTIVE_TEXT} ⢎  Reticulating splines... ${RESET}${FG_ACTIVE}${PL_RCURVE}${FG_DIM}───────────────────╯${RESET}"
print ""

# Action bar colors from response-dialog.tsx
BG_SELECTED=$'\033[48;2;55;45;80m'
FG_GOLD_PRI=$'\033[38;2;245;200;100m'    # #f5c864 primary unselected
FG_GOLD_SEL=$'\033[38;2;255;220;120m'    # #ffdc78 primary selected
FG_SEC=$'\033[38;2;170;170;195m'         # #aaaac3 secondary unselected
FG_SEC_SEL=$'\033[38;2;200;200;224m'     # #c8c8e0 secondary selected
FG_LABEL=$'\033[38;2;115;115;140m'       # #73738c label text
FG_LABEL_SEL=$'\033[38;2;235;230;250m'   # #ebe6fa label text selected
FG_SEP=$'\033[38;2;65;65;80m'            # #414150 separator
UNDERLINE=$'\033[4m'

# Brighter selected background for contrast
BG_SEL_BRIGHT=$'\033[48;2;70;55;110m'

print "  ${DIM}Action bar — current look (Yes selected):${RESET}"
print -n "     ${FG_WHITE}Run command? ${RESET}"
print -n " ${FG_GOLD_PRI}${BOLD}${UNDERLINE}N${RESET}${FG_LABEL}o ${RESET}"
print -n " ${BG_SELECTED}${FG_GOLD_SEL}${BOLD}${UNDERLINE}Y${RESET}${BG_SELECTED}${FG_LABEL_SEL}${BOLD}es ${RESET}"
print -n "${FG_SEP} │ ${RESET}"
print -n " ${FG_SEC}${UNDERLINE}D${RESET}${FG_LABEL}escribe ${RESET}"
print -n " ${FG_SEC}${UNDERLINE}E${RESET}${FG_LABEL}dit ${RESET}"
print -n " ${FG_SEC}${UNDERLINE}F${RESET}${FG_LABEL}ollow-up ${RESET}"
print " ${FG_SEC}${UNDERLINE}C${RESET}${FG_LABEL}opy${RESET}"
print ""

print "  ${DIM}Action bar in bottom border pill (Yes selected):${RESET}"
print -n "  ${FG_DIM}╰─"
print -n "${FG_MID}${PL_LCURVE}${BG_MID}"
print -n "${FG_WHITE} Run?  "
print -n "${FG_GOLD_PRI}${BOLD}${UNDERLINE}N${RESET}${BG_MID}${FG_LABEL}o  "
print -n "${RESET}${FG_MID}${BG_SEL_BRIGHT}${PL_LCURVE}${RESET}"
print -n "${BG_SEL_BRIGHT} ${FG_GOLD_SEL}${BOLD}${UNDERLINE}Y${RESET}${BG_SEL_BRIGHT}${FG_LABEL_SEL}${BOLD}es ${RESET}"
print -n "${FG_MID}${PL_RCURVE}${RESET}"
print -n "${BG_MID}${FG_SEP}  │  ${RESET}"
print -n "${BG_MID}${FG_SEC}${UNDERLINE}D${RESET}${BG_MID}${FG_LABEL}escribe  "
print -n "${FG_SEC}${UNDERLINE}E${RESET}${BG_MID}${FG_LABEL}dit  "
print -n "${FG_SEC}${UNDERLINE}F${RESET}${BG_MID}${FG_LABEL}ollow-up  "
print -n "${FG_SEC}${UNDERLINE}C${RESET}${BG_MID}${FG_LABEL}opy "
print "${RESET}${FG_MID}${PL_RCURVE}${FG_DIM}─╯${RESET}"
print ""

FG_SEL_BRIGHT=$'\033[38;2;70;55;110m'

print "  ${DIM}Action bar in bottom border pill (No selected):${RESET}"
print -n "  ${FG_DIM}╰─"
print -n "${FG_MID}${PL_LCURVE}${BG_MID}"
print -n "${FG_WHITE} Run?  "
print -n "${RESET}${FG_MID}${BG_SEL_BRIGHT}${PL_LCURVE}${RESET}"
print -n "${BG_SEL_BRIGHT} ${FG_GOLD_SEL}${BOLD}${UNDERLINE}N${RESET}${BG_SEL_BRIGHT}${FG_LABEL_SEL}${BOLD}o ${RESET}"
print -n "${FG_SEL_BRIGHT}${BG_MID}${PL_RCURVE}${RESET}"
print -n "${BG_MID}  ${FG_GOLD_PRI}${BOLD}${UNDERLINE}Y${RESET}${BG_MID}${FG_LABEL}es"
print -n "${FG_SEP}  │  ${RESET}"
print -n "${BG_MID}${FG_SEC}${UNDERLINE}D${RESET}${BG_MID}${FG_LABEL}escribe  "
print -n "${FG_SEC}${UNDERLINE}E${RESET}${BG_MID}${FG_LABEL}dit  "
print -n "${FG_SEC}${UNDERLINE}F${RESET}${BG_MID}${FG_LABEL}ollow-up  "
print -n "${FG_SEC}${UNDERLINE}C${RESET}${BG_MID}${FG_LABEL}opy "
print "${RESET}${FG_MID}${PL_RCURVE}${FG_DIM}─╯${RESET}"
print ""

print "  ${DIM}Action bar in bottom border pill (Describe selected):${RESET}"
print -n "  ${FG_DIM}╰─"
print -n "${FG_MID}${PL_LCURVE}${BG_MID}"
print -n "${FG_WHITE} Run?  "
print -n "${FG_GOLD_PRI}${BOLD}${UNDERLINE}N${RESET}${BG_MID}${FG_LABEL}o  "
print -n "${FG_GOLD_PRI}${BOLD}${UNDERLINE}Y${RESET}${BG_MID}${FG_LABEL}es"
print -n "${FG_SEP}  │  ${RESET}"
print -n "${RESET}${FG_MID}${BG_SEL_BRIGHT}${PL_LCURVE}${RESET}"
print -n "${BG_SEL_BRIGHT} ${FG_SEC_SEL}${BOLD}${UNDERLINE}D${RESET}${BG_SEL_BRIGHT}${FG_LABEL_SEL}${BOLD}escribe ${RESET}"
print -n "${FG_SEL_BRIGHT}${BG_MID}${PL_RCURVE}${RESET}"
print -n "${BG_MID}  ${FG_SEC}${UNDERLINE}E${RESET}${BG_MID}${FG_LABEL}dit  "
print -n "${FG_SEC}${UNDERLINE}F${RESET}${BG_MID}${FG_LABEL}ollow-up  "
print -n "${FG_SEC}${UNDERLINE}C${RESET}${BG_MID}${FG_LABEL}opy "
print "${RESET}${FG_MID}${PL_RCURVE}${FG_DIM}─╯${RESET}"

# ────────────────────────────────────────────────────────────────
header "E. KEY HINTS — Pill Keycaps"
print "  Keyboard shortcut combos (Space, ⏎, Esc) wrapped in curve pills"
print "  instead of plain bold text. More visual weight, reads like keycaps."
print "  FILE: KeyHints component in config-wizard-dialog.tsx + response-dialog.tsx"
print ""

print "  ${DIM}Wizard provider screen:${RESET}"
print -n "  "
print -n "  ${FG_MID}${PL_LCURVE}${BG_MID}${FG_GOLD}${BOLD} Space ${RESET}${FG_MID}${PL_RCURVE}${RESET}"
print -n "${FG_DIM} toggle  "
print -n "${FG_MID}${PL_LCURVE}${BG_MID}${FG_GOLD}${BOLD} ⏎ ${RESET}${FG_MID}${PL_RCURVE}${RESET}"
print "${FG_DIM} continue"
print ""

print "  ${DIM}Response dialog edit mode:${RESET}"
print -n "  "
print -n "  ${FG_MID}${PL_LCURVE}${BG_MID}${FG_GOLD}${BOLD} ⏎ ${RESET}${FG_MID}${PL_RCURVE}${RESET}"
print -n "${FG_DIM} run  "
print -n "${FG_MID}${PL_LCURVE}${BG_MID}${FG_WHITE}${BOLD} Esc ${RESET}${FG_MID}${PL_RCURVE}${RESET}"
print "${FG_DIM} discard"
print ""

print "  ${DIM}Disclaimer:${RESET}"
print -n "  "
print -n "  ${FG_MID}${PL_LCURVE}${BG_MID}${FG_GOLD}${BOLD} ⏎ ${RESET}${FG_MID}${PL_RCURVE}${RESET}"
print -n "${FG_DIM} accept  "
print -n "${FG_MID}${PL_LCURVE}${BG_MID}${FG_WHITE}${BOLD} Esc ${RESET}${FG_MID}${PL_RCURVE}${RESET}"
print "${FG_DIM} skip provider"

# ────────────────────────────────────────────────────────────────
header "F. SPINNER — Pill in Bottom Border"
print "  Spinner + status text (\"thinking...\", \"Loading models…\") wrapped in"
print "  curve pill in bottom border instead of bare text with dashes."
print "  FILE: border.ts bottomBorderSegments() — when status contains spinner"
print ""

print "  ${FG_DIM}╰──${FG_ACTIVE}${PL_LCURVE}${BG_ACTIVE}${FG_ACTIVE_TEXT} ⢎  thinking... ${RESET}${FG_ACTIVE}${PL_RCURVE}${FG_DIM}────────────────────────────────╯${RESET}"
print ""
print "  ${FG_DIM}╰──${FG_ACTIVE}${PL_LCURVE}${BG_ACTIVE}${FG_ACTIVE_TEXT} ⠎⠁ thinking... ${RESET}${FG_ACTIVE}${PL_RCURVE}${FG_DIM}────────────────────────────────╯${RESET}"
print ""
print "  ${FG_DIM}╰──${FG_ACTIVE}${PL_LCURVE}${BG_ACTIVE}${FG_ACTIVE_TEXT} ⠈⠱ Running step... ${RESET}${FG_ACTIVE}${PL_RCURVE}${FG_DIM}────────────────────────────╯${RESET}"

# ════════════════════════════════════════════════════════════════
#  WIZARD COMPONENTS
# ════════════════════════════════════════════════════════════════

header "G. CHECKLIST CURSOR — Curve Pill Highlight"
print "  Currently focused checklist row uses ❯ pointer + bg color #1a2a4d."
print "  Replace with curve pill wrapping the entire row — cleaner focus."
print "  FILE: checklist.tsx — replace pointer + backgroundColor with pill glyphs"
print ""

print "  ${FG_ACTIVE}${PL_LCURVE}${BG_ACTIVE}${FG_ACTIVE_TEXT}${BOLD} [✓] ${ICON_ANTHRO} Anthropic ${RESET}${FG_ACTIVE}${PL_RCURVE}${RESET}"
print "    ${FG_GREEN}[✓] ${ICON_OPENAI} OpenAI${RESET}"
print "    ${FG_DIM}[ ] ${ICON_ROUTER} OpenRouter${RESET}"
print "    ${FG_DIM}[ ] ${ICON_OLLAMA} Ollama${RESET}"

# ────────────────────────────────────────────────────────────────
# SKIPPED — keeping [✓]/[ ] checkbox style.
# header "H. CHECKBOX — Nerd Icon Toggle"
# print "  Replace [✓]/[ ] checkbox text with nerd font icons."
# print "  Several options shown — toggle switches, checkbox icons, circles,"
# print "  pill toggles, or combined pill cursor + checkbox icon."
# print "  FILE: checklist.tsx — swap tick/checkbox rendering"
# print ""
#
# print "  ${DIM}Option 1 — Toggle icons:${RESET}"
# print "  ${FG_GREEN}${ICON_TOGGLE_ON}${RESET}  Anthropic"
# print "  ${FG_GREEN}${ICON_TOGGLE_ON}${RESET}  OpenAI"
# print "  ${FG_DIM}${ICON_TOGGLE_OFF}${RESET}  OpenRouter"
# print ""
#
# print "  ${DIM}Option 2 — Checkbox icons:${RESET}"
# print "  ${FG_GREEN}${ICON_CHECKBOX}${RESET}  Anthropic"
# print "  ${FG_GREEN}${ICON_CHECKBOX}${RESET}  OpenAI"
# print "  ${FG_DIM}${ICON_SQUARE_O}${RESET}  OpenRouter"
# print ""
#
# print "  ${DIM}Option 3 — Filled/empty circles:${RESET}"
# print "  ${FG_GREEN}${ICON_CIRCLE}${RESET}  Anthropic"
# print "  ${FG_GREEN}${ICON_CIRCLE}${RESET}  OpenAI"
# print "  ${FG_DIM}${ICON_CIRCLE_O}${RESET}  OpenRouter"
# print ""
#
# print "  ${DIM}Option 4 — Pill toggle (powerline + nerd):${RESET}"
# print "  ${FG_DONE}${PL_LCURVE}${BG_DONE}${FG_DONE_TEXT}${BOLD}${ICON_CHECK}${RESET}${FG_DONE}${PL_RCURVE}${RESET} Anthropic"
# print "  ${FG_DONE}${PL_LCURVE}${BG_DONE}${FG_DONE_TEXT}${BOLD}${ICON_CHECK}${RESET}${FG_DONE}${PL_RCURVE}${RESET} OpenAI"
# print "  ${FG_PENDING}${PL_LCURVE}${BG_PENDING}${FG_PENDING_TEXT} ${RESET}${FG_PENDING}${PL_RCURVE}${RESET} OpenRouter"
# print ""
#
# print "  ${DIM}Combined — pill toggle + pill cursor:${RESET}"
# print "  ${FG_ACTIVE}${PL_LCURVE}${BG_ACTIVE}${FG_ACTIVE_TEXT}${BOLD} ${FG_GREEN}${ICON_CHECKBOX}${FG_ACTIVE_TEXT} Anthropic ${RESET}${FG_ACTIVE}${PL_RCURVE}${RESET}"
# print "    ${FG_GREEN}${ICON_CHECKBOX}${RESET}  OpenAI"
# print "    ${FG_DIM}${ICON_SQUARE_O}${RESET}  OpenRouter"

# ────────────────────────────────────────────────────────────────
header "I. MODEL PICKER — Recommended Pill"
print "  Currently recommended models show '✦ Recommended' as plain text."
print "  Replace with a curve pill badge for visual pop."
print "  FILE: config-wizard-dialog.tsx ModelPickerScreen options mapping"
print ""

print "    claude-sonnet-4-20250514 ${FG_DONE}${PL_LCURVE}${BG_DONE}${FG_DONE_TEXT}${BOLD} ${ICON_STAR} Recommended ${RESET}${FG_DONE}${PL_RCURVE}${RESET}"
print "    claude-haiku-4-20250506"
print "    claude-opus-4-20250514"

# ────────────────────────────────────────────────────────────────
header "J. DISCLAIMER — Warning Pill Banner"
print "  Claude Code disclaimer screen (routes through claude CLI) gets a"
print "  warning pill header instead of plain text paragraph. Esc disables"
print "  Claude Code provider entirely (not just skips)."
print "  FILE: config-wizard-dialog.tsx DisclaimerScreen"
print ""

print "  ${FG_ORANGE_BG}${PL_LCURVE}${BG_ORANGE}${FG_ORANGE}${BOLD} ${ICON_WARN} Heads Up ${RESET}${FG_ORANGE_BG}${PL_RCURVE}${RESET}"
print ""
print "  ${FG_DIM}Wrap will route your queries through the ${BOLD}claude${RESET}${FG_DIM} CLI"
print "  ${FG_DIM}instead of calling the Anthropic API directly. This is"
print "  ${FG_DIM}slower, and your prompts flow through Claude Code under"
print "  ${FG_DIM}its own terms — bring your own subscription.${RESET}"
print ""
print -n "  "
print -n "${FG_MID}${PL_LCURVE}${BG_MID}${FG_GOLD}${BOLD} ⏎ ${RESET}${FG_MID}${PL_RCURVE}${RESET}"
print -n "${FG_DIM} accept  "
print -n "${FG_MID}${PL_LCURVE}${BG_MID}${FG_WHITE}${BOLD} Esc ${RESET}${FG_MID}${PL_RCURVE}${RESET}"
print "${FG_DIM} disable Claude Code${RESET}"

# ════════════════════════════════════════════════════════════════
#  WIZARD COMPLETION
# ════════════════════════════════════════════════════════════════

header "K. WIZARD COMPLETION — Final Screen"
print "  NEW SCREEN: Added after 'picking-default' in wizard state machine."
print "  Shows: all-green breadcrumbs, '✓ All set!' pill, config card with"
print "  provider/model/API key summary, 'Rerun with w --setup' hint, and"
print "  ⏎ to continue to their original query."
print "  FILES: wizard/state.ts (add 'complete' screen), config-wizard-dialog.tsx"
print ""

# Top border with full breadcrumbs (all done)
print "  ${FG_BLUE}╭${dashes}╮${RESET}"
print -n "  ${FG_BLUE}│${RESET}"
print -n "${FG_WIZARD}${PL_LCURVE}${BG_WIZARD}${FG_WHITE}${BOLD} 🧙 Setup Wizard ${RESET}"
print -n "${FG_WIZARD}${BG_DONE}${PL_RFLAME}${RESET}"
print -n "${BG_DONE}${FG_DONE_TEXT} ${ICON_CHECK} ${ICON_LIST} Providers ${RESET}"
print -n "${FG_DONE}${BG_DONE}${PL_RFLAME}${RESET}"
print -n "${BG_DONE}${FG_DONE_TEXT} ${ICON_CHECK} ${ICON_KEY} API Key ${RESET}"
print -n "${FG_DONE}${BG_DONE}${PL_RFLAME}${RESET}"
print -n "${BG_DONE}${FG_DONE_TEXT} ${ICON_CHECK} ${ICON_CUBE} Model ${RESET}"
print -n "${FG_DONE}${BG_DONE}${PL_RFLAME}${RESET}"
print "${BG_DONE}${FG_DONE_TEXT} ${ICON_CHECK} ${ICON_STAR} Default ${RESET}${FG_DONE}${PL_RFLAME}${RESET}${FG_DIM}│${RESET}"
print "  ${FG_BLUE}│${RESET}                                                          ${FG_DIM}│${RESET}"

# Success header
print -n "  ${FG_BLUE}│${RESET}  "
print -n "${FG_DONE}${PL_LCURVE}${BG_DONE}${FG_DONE_TEXT}${BOLD} ${ICON_CHECK} All set! ${RESET}${FG_DONE}${PL_RCURVE}${RESET}"
print "                                          ${FG_DIM}│${RESET}"
print "  ${FG_BLUE}│${RESET}                                                          ${FG_DIM}│${RESET}"

# Config card
print -n "  ${FG_BLUE}│${RESET}  "
print -n "${FG_MID}${PL_LCURVE}${BG_MID}${FG_WHITE}${BOLD} Provider ${RESET}${FG_MID}${PL_RCURVE}${RESET}"
print " Anthropic                                  ${FG_DIM}│${RESET}"
print -n "  ${FG_BLUE}│${RESET}  "
print -n "${FG_MID}${PL_LCURVE}${BG_MID}${FG_WHITE}${BOLD} Model    ${RESET}${FG_MID}${PL_RCURVE}${RESET}"
print " claude-sonnet-4                            ${FG_DIM}│${RESET}"
print -n "  ${FG_BLUE}│${RESET}  "
print -n "${FG_MID}${PL_LCURVE}${BG_MID}${FG_WHITE}${BOLD} API Key  ${RESET}${FG_MID}${PL_RCURVE}${RESET}"
print " sk-ant-••••••••••••                        ${FG_DIM}│${RESET}"
print "  ${FG_BLUE}│${RESET}                                                          ${FG_DIM}│${RESET}"

# Instructions
print "  ${FG_DIM}│${RESET}  ${FG_DIM}Rerun anytime with ${BOLD}w --setup${RESET}                              ${FG_DIM}│${RESET}"
print "  ${FG_DIM}│${RESET}                                                          ${FG_DIM}│${RESET}"

# Key hints
print -n "  ${FG_DIM}│${RESET}  "
print -n "${FG_MID}${PL_LCURVE}${BG_MID}${FG_GOLD}${BOLD} ⏎ ${RESET}${FG_MID}${PL_RCURVE}${RESET}"
print "${FG_DIM} done                                              ${FG_DIM}│${RESET}"

# Bottom border
print "  ${FG_DIM}╰──────────────────────────────────────────────────────────╯${RESET}"

# ════════════════════════════════════════════════════════════════
#  RESPONSE DIALOG
# ════════════════════════════════════════════════════════════════

header "L. PLAN DISPLAY — Pill Label"
print "  Currently 'Plan: ...' is rendered as colored text (#6f8fb4)."
print "  Replace with a curve pill icon label + plan text."
print "  Also works for step count display (Step 1/3)."
print "  FILE: response-dialog.tsx plan rendering section"
print ""

print -n "  ${FG_ACTIVE}${PL_LCURVE}${BG_ACTIVE}${FG_ACTIVE_TEXT}${BOLD} ${ICON_LIST} Plan ${RESET}${FG_ACTIVE}${PL_RCURVE}${RESET}"
print " First list files, then filter by date"
print ""

print -n "  ${FG_ACTIVE}${PL_LCURVE}${BG_ACTIVE}${FG_ACTIVE_TEXT}${BOLD} ${ICON_LIST} Step 1/3 ${RESET}${FG_ACTIVE}${PL_RCURVE}${RESET}"
print " List all TypeScript files"

# ────────────────────────────────────────────────────────────────
header "M. COMMAND FOLD — Pill Indicator"
print "  When command is too long, truncateCommand() inserts '… N lines hidden'."
print "  Wrap that indicator in a curve pill for visual distinction from code."
print "  FILE: response-dialog.tsx truncateCommand()"
print ""

print "  ${FG_WHITE}find . -name '*.ts'${RESET}"
print "  ${FG_MID}${PL_LCURVE}${BG_MID}${FG_WHITE} ··· 12 lines hidden ··· ${RESET}${FG_MID}${PL_RCURVE}${RESET}"
print "  ${FG_WHITE}  -exec wc -l {} +${RESET}"


# ════════════════════════════════════════════════════════════════
#  NON-DIALOG CHROME
# ════════════════════════════════════════════════════════════════

header "O. ANSWER MODE — Source Pill"
print "  In answer mode (w -a), response goes to stdout as plain text."
print "  Add a stderr chrome header pill showing 'Answer' + provider/model."
print "  Stdout stays clean for piping — this is stderr-only decoration."
print "  FILE: session.ts answer output path, output.ts chrome()"
print ""

print -n "  ${FG_TEAL_BG}${PL_LCURVE}${BG_TEAL}${FG_TEAL}${BOLD} ${ICON_BOLT} Answer ${RESET}${FG_TEAL_BG}${PL_RCURVE}${RESET}"
print -n "  via "
print "${FG_BADGE}${PL_LCURVE}${BG_BADGE}${FG_BADGE_TEXT} ${ICON_ANTHRO} sonnet-4 ${RESET}${FG_BADGE}${PL_RCURVE}${RESET}"
print ""
print "  ${FG_WHITE}The node_modules directory is 847MB. The largest"
print "  packages are typescript (42MB) and webpack (38MB).${RESET}"

# ────────────────────────────────────────────────────────────────
header "P. TOKEN / COST — Pill Display"
print "  Show token count and estimated cost as curve pills after completion."
print "  Could appear as stderr chrome or embedded in bottom border."
print "  FILE: session.ts post-completion output, border.ts"
print ""

print -n "  ${FG_MID}${PL_LCURVE}${BG_MID}${FG_WHITE} ${ICON_BOLT} 847 tokens ${RESET}${FG_MID}${PL_RCURVE}${RESET}"
print -n "  ${FG_DONE}${PL_LCURVE}${BG_DONE}${FG_DONE_TEXT} \$0.002 ${RESET}${FG_DONE}${PL_RCURVE}${RESET}"
print ""
print ""

print "  ${DIM}In bottom border:${RESET}"
print "  ${FG_DIM}╰────────────────────${FG_MID}${PL_LCURVE}${BG_MID}${FG_WHITE} 847 tok ${RESET}${FG_MID}${PL_RCURVE}${FG_DIM}──${FG_DONE}${PL_LCURVE}${BG_DONE}${FG_DONE_TEXT} \$0.002 ${RESET}${FG_DONE}${PL_RCURVE}${FG_DIM}──────────╯${RESET}"

# ────────────────────────────────────────────────────────────────
header "Q. RATE LIMIT / RETRY — Countdown"
print "  When LLM returns 429 Too Many Requests, show a warning pill with"
print "  provider icon, retry count, and countdown timer pill."
print "  FILE: LLM provider error handling, chrome() output"
print ""

print -n "  ${FG_ORANGE_BG}${PL_LCURVE}${BG_ORANGE}${FG_ORANGE}${BOLD} ${ICON_WARN} Rate limited ${RESET}${FG_ORANGE_BG}${PL_RCURVE}${RESET}"
print -n "  Retrying in "
print "${FG_ORANGE}${PL_LCURVE}${BG_ORANGE}${FG_DARK}${BOLD} 3s ${RESET}${FG_ORANGE_BG}${PL_RCURVE}${RESET}"
print ""

print -n "  ${FG_ORANGE_BG}${PL_LCURVE}${BG_ORANGE}${FG_ORANGE} ${ICON_WARN} ${RESET}${FG_ORANGE_BG}${PL_RCURVE}${RESET}"
print -n " ${ICON_ANTHRO} 429 Too Many Requests "
print -n "${FG_MID}${PL_LCURVE}${BG_MID}${FG_WHITE} retry #2 ${RESET}${FG_MID}${PL_RCURVE}${RESET}"
print -n " ${FG_MID}${PL_LCURVE}${BG_MID}${FG_WHITE} 5s ${RESET}${FG_MID}${PL_RCURVE}${RESET}"
print ""

# ════════════════════════════════════════════════════════════════
#  DESIGN PATTERNS
# ════════════════════════════════════════════════════════════════

header "R. NESTED PILLS — Compound Labels"
print "  Design pattern: adjacent pills sharing an edge for compound info"
print "  (e.g. provider+model, risk+command, status chain). No specific use"
print "  yet — keeping as reference for future status bars, verbose output,"
print "  or post-run summaries."
print ""

print "  ${DIM}Provider + model:${RESET}"
print -n "  "
print -n "${FG_BADGE}${PL_LCURVE}${BG_BADGE}${FG_BADGE_TEXT} ${ICON_ANTHRO} Anthropic ${RESET}"
print -n "${FG_BADGE}${BG_ACTIVE}${PL_RCURVE}${RESET}"
print -n "${BG_ACTIVE}${FG_ACTIVE_TEXT} sonnet-4 ${RESET}"
print "${FG_ACTIVE}${PL_RCURVE}${RESET}"
print ""

print "  ${DIM}Risk + command:${RESET}"
print -n "  "
print -n "${FG_RED_BG}${PL_LCURVE}${BG_RED}${FG_RED}${BOLD} ${ICON_WARN} HIGH ${RESET}"
print -n "${FG_RED_BG}${BG_INPUT}${PL_RCURVE}${RESET}"
print -n "${BG_INPUT}${FG_WHITE} rm -rf / ${RESET}"
print "${FG_INPUT}${PL_RCURVE}${RESET}"
print ""

print "  ${DIM}Status chain:${RESET}"
print -n "  "
print -n "${BG_DONE}${FG_DONE_TEXT}${BOLD} ${ICON_CHECK} ${RESET}"
print -n "${FG_DONE}${BG_BADGE}${PL_RIGHT}${RESET}"
print -n "${BG_BADGE}${FG_BADGE_TEXT} ${ICON_ANTHRO} ${RESET}"
print -n "${FG_BADGE}${BG_ACTIVE}${PL_RIGHT}${RESET}"
print -n "${BG_ACTIVE}${FG_ACTIVE_TEXT} sonnet-4 ${RESET}"
print -n "${FG_ACTIVE}${BG_MID}${PL_RIGHT}${RESET}"
print -n "${BG_MID}${FG_WHITE} 0.8s ${RESET}"
print -n "${FG_MID}${BG_DONE}${PL_RIGHT}${RESET}"
print -n "${BG_DONE}${FG_DONE_TEXT} \$0.002 ${RESET}"
print "${FG_DONE}${PL_RIGHT}${RESET}"

# ════════════════════════════════════════════════════════════════
#  FULL COMPOSITE
# ════════════════════════════════════════════════════════════════

header "S. FULL WIZARD — Everything Together"
print ""

print "  ${FG_BLUE}╭${dashes}╮${RESET}"
# Breadcrumbs — step 2, only shows completed + current
print -n "  ${FG_BLUE}│${RESET}"
print -n "${FG_WIZARD}${PL_LCURVE}${BG_WIZARD}${FG_WHITE}${BOLD} 🧙 Setup Wizard ${RESET}"
print -n "${FG_WIZARD}${BG_DONE}${PL_RFLAME}${RESET}"
print -n "${BG_DONE}${FG_DONE_TEXT} ${ICON_CHECK} ${ICON_LIST} Providers ${RESET}"
print -n "${FG_DONE}${BG_ACTIVE}${PL_RFLAME}${RESET}"
print -n "${BG_ACTIVE}${FG_ACTIVE_TEXT}${BOLD} ${ICON_KEY} API Key ${RESET}"
print "${FG_ACTIVE}${PL_RFLAME}${RESET}            ${FG_DIM}│${RESET}"
print "  ${FG_BLUE}│${RESET}                                                          ${FG_DIM}│${RESET}"

# Title
print "  ${FG_BLUE}│${RESET}  ${BOLD}Anthropic API key${RESET}                                       ${FG_DIM}│${RESET}"
print "  ${FG_BLUE}│${RESET}  ${FG_DIM}Get one: https://console.anthropic.com/keys${RESET}             ${FG_DIM}│${RESET}"
print "  ${FG_BLUE}│${RESET}                                                          ${FG_DIM}│${RESET}"

# Input
print "  ${FG_BLUE}│${RESET}  ${BG_INPUT}${FG_WHITE} sk-ant-•••••••••••••••••••••••••••••             ${RESET}  ${FG_DIM}│${RESET}"
print "  ${FG_BLUE}│${RESET}                                                          ${FG_DIM}│${RESET}"

# Key hints
print -n "  ${FG_DIM}│${RESET}  "
print -n "${FG_MID}${PL_LCURVE}${BG_MID}${FG_GOLD}${BOLD} ⏎ ${RESET}${FG_MID}${PL_RCURVE}${RESET}"
print "${FG_DIM} continue                                              ${FG_DIM}│${RESET}"

# Bottom border
print "  ${FG_DIM}╰──────────────────────────────────────────────────────────╯${RESET}"

# ────────────────────────────────────────────────────────────────
print ""
header "T. FULL RESPONSE DIALOG — High Risk + Plan"
print ""

dashes8=$(printf '─%.0s' {1..42})
print "  ${FG_RED}╭${dashes8}${FG_RED_BG}${PL_LCURVE}${BG_RED}${FG_RED}${BOLD} ${ICON_WARN} high risk ${RESET}${FG_RED_BG}${PL_RCURVE}${FG_DIM}──╮${RESET}"
print "  ${FG_RED}│${RESET}                                                        ${FG_DIM}│${RESET}"
print "  ${FG_RED}│${RESET}  ${BG_INPUT}${FG_WHITE} rm -rf /tmp/build-artifacts/*                   ${RESET}  ${FG_DIM}│${RESET}"
print "  ${FG_RED}│${RESET}                                                        ${FG_DIM}│${RESET}"
print -n "  ${FG_DIM}│${RESET}  "
print -n "${FG_ACTIVE}${PL_LCURVE}${BG_ACTIVE}${FG_ACTIVE_TEXT}${BOLD} ${ICON_LIST} Plan ${RESET}${FG_ACTIVE}${PL_RCURVE}${RESET}"
print " ${FG_BLUE}Clean build dir, then rebuild${RESET}            ${FG_DIM}│${RESET}"
print "  ${FG_DIM}│${RESET}                                                        ${FG_DIM}│${RESET}"
print "  ${FG_DIM}│${RESET}  ${FG_DIM}Recursively removes all build artifacts.${RESET}            ${FG_DIM}│${RESET}"
print "  ${FG_DIM}│${RESET}                                                        ${FG_DIM}│${RESET}"
print "  ${FG_DIM}│${RESET}                                                        ${FG_DIM}│${RESET}"
print "  ${FG_DIM}│${RESET}  ${FG_WHITE} Run command?  ${FG_GOLD}${BOLD}No  Yes${RESET}${FG_DIM}  │  Describe  Edit  Follow  Copy${RESET}  ${FG_DIM}│${RESET}"
print "  ${FG_DIM}╰──────────────────────────────────────────────────────────╯${RESET}"

# ════════════════════════════════════════════════════════════════
print ""
header "IMPLEMENTATION NOTES"
print ""
print "  ${BOLD}All powerline enhancements are nerd-font-only.${RESET}"
print "  ${FG_DIM}When nerdFonts disabled, fall back to current glyphs.${RESET}"
print "  ${FG_DIM}Use resolveIcon() / isNerdFonts() for conditional rendering.${RESET}"
print ""
print "  ${BOLD}Files to modify:${RESET}"
print "  ${FG_BLUE}border.ts${RESET}                 C, D, F — badge pill, bottom status pill"
print "  ${FG_BLUE}checklist.tsx${RESET}             G, H — cursor pill, toggle icons"
print "  ${FG_BLUE}config-wizard-dialog.tsx${RESET}  A, B, I, J, K — breadcrumbs, completion"
print "  ${FG_BLUE}response-dialog.tsx${RESET}       E, L, M — key hints, plan label, fold"
print "  ${FG_BLUE}risk-presets.ts${RESET}            C — no change needed, just border.ts"
print "  ${FG_BLUE}spinner.ts${RESET}                N — alternative spinner frames"
print "  ${FG_BLUE}session.ts / output.ts${RESET}    O, P, Q — answer chrome, cost, retry"
print "  ${FG_BLUE}wizard/state.ts${RESET}           K — add 'complete' screen to state machine"
print ""
print "  ${BOLD}New constants needed:${RESET}"
print "  ${FG_WHITE}PL_LCURVE = '\\uE0B6'${RESET}    left curve"
print "  ${FG_WHITE}PL_RCURVE = '\\uE0B4'${RESET}    right curve"
print "  ${FG_WHITE}PL_RFLAME = '\\uE0C0'${RESET}    right flame (breadcrumbs only)"
print "  ${FG_WHITE}PL_RTHIN  = '\\uE0B1'${RESET}    thin separator (compact breadcrumbs)"
print ""
