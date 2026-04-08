#!/bin/bash
# Dialog visual reference — run `bash specs/dialog-style.sh` to preview.
# This is not production code. It's a pixel-perfect ANSI mockup of the target design.
# The actual implementation uses Ink (React) components in src/tui/dialog.tsx.

RST=$'\033[0m'
BOLD=$'\033[1m'
UL=$'\033[4m'

# Shared palette
CMD_BG=$'\033[48;2;35;35;50m'
EXPL=$'\033[38;2;135;135;155m'
CMD_W=$'\033[38;2;235;235;245m'
WHITE=$'\033[38;2;210;210;225m'
HINT=$'\033[38;2;115;115;140m'
HINT_KEY=$'\033[38;2;170;170;195m'
ACCENT_KEY=$'\033[38;2;245;200;100m'
YN_SEP=$'\033[38;2;65;65;80m'

# Syntax highlighting colors
V_CMD=$'\033[38;2;255;180;100m'    # command names: warm orange
V_FLAG=$'\033[38;2;100;220;255m'   # flags: cyan
V_STR=$'\033[38;2;255;100;180m'    # strings/values: pink

# Synthwave medium: pink → purple → dim
M1=$'\033[38;2;255;100;200m'
M2=$'\033[38;2;240;100;210m'
M3=$'\033[38;2;220;100;225m'
M4=$'\033[38;2;190;100;240m'
M5=$'\033[38;2;160;100;250m'
M6=$'\033[38;2;130;100;240m'
M7=$'\033[38;2;100;100;220m'
M8=$'\033[38;2;80;90;190m'
M9=$'\033[38;2;70;80;150m'
MD=$'\033[38;2;60;60;100m'

# Synthwave high: hot red → purple → dim
H1=$'\033[38;2;255;60;80m'
H2=$'\033[38;2;245;60;100m'
H3=$'\033[38;2;230;65;130m'
H4=$'\033[38;2;210;70;160m'
H5=$'\033[38;2;185;75;190m'
H6=$'\033[38;2;155;80;210m'
H7=$'\033[38;2;125;85;210m'
H8=$'\033[38;2;100;85;190m'
H9=$'\033[38;2;80;80;155m'
HD=$'\033[38;2;60;60;100m'

# Badge colors
BADGE_MED_BG=$'\033[48;2;80;60;30m'
BADGE_MED_FG=$'\033[38;2;255;200;80m'
BADGE_HI_BG=$'\033[48;2;80;25;25m'
BADGE_HI_FG=$'\033[38;2;255;100;100m'

ACTION="${WHITE}Run command?${RST}  ${BOLD}${UL}${ACCENT_KEY}Y${RST}${HINT}es  ${BOLD}${UL}${ACCENT_KEY}N${RST}${HINT}o  ${YN_SEP}│${RST}  ${BOLD}${UL}${HINT_KEY}D${RST}${HINT}escribe  ${BOLD}${UL}${HINT_KEY}E${RST}${HINT}dit  ${BOLD}${UL}${HINT_KEY}F${RST}${HINT}ollow-up  ${BOLD}${UL}${HINT_KEY}C${RST}${HINT}opy${RST}"

# ─── MEDIUM RISK ───
echo ""
echo "  ${BOLD}${WHITE}Medium risk${RST}"
echo ""
echo "  ${M1}╭${M1}─${M2}─${M2}─${M3}─${M3}─${M4}─${M4}─${M5}─${M5}─${M6}─${M6}─${M7}─${M7}─${M8}─${M8}─${M9}─${M9}─${MD}──────────────── ${BADGE_MED_BG}${BADGE_MED_FG}${BOLD} ⚠ medium ${RST}${MD} ─╮${RST}"
echo "  ${M1}│${RST}                                                          ${MD}│${RST}"
echo "  ${M1}│${RST}  ${CMD_BG} ${BOLD}${V_CMD}find${RST}${CMD_BG} ${CMD_W}/${RST}${CMD_BG} ${V_FLAG}-name${RST}${CMD_BG} ${V_STR}'*.conf'${RST}${CMD_BG} ${V_FLAG}-delete${RST}${CMD_BG}                    ${RST}${MD}│${RST}"
echo "  ${M1}│${RST}  ${EXPL} Finds and deletes all .conf files recursively${RST}        ${MD}│${RST}"
echo "  ${M2}│${RST}                                                          ${MD}│${RST}"
echo "  ${M3}│${RST}                                                          ${MD}│${RST}"
echo "  ${M4}│${RST}   ${ACTION}  ${MD}│${RST}"
echo "  ${M5}│${RST}                                                          ${MD}│${RST}"
echo "  ${M6}╰${M7}─${M8}─${M9}─${MD}──────────────────────────────────────────────────────╯${RST}"
echo ""

# ─── HIGH RISK ───
echo ""
echo "  ${BOLD}${WHITE}High risk${RST}"
echo ""
echo "  ${H1}╭${H1}─${H2}─${H2}─${H3}─${H3}─${H4}─${H4}─${H5}─${H5}─${H6}─${H6}─${H7}─${H7}─${H8}─${H8}─${H9}─${H9}─${HD}──────────────────── ${BADGE_HI_BG}${BADGE_HI_FG}${BOLD} ⚠ high ${RST}${HD} ─╮${RST}"
echo "  ${H1}│${RST}                                                          ${HD}│${RST}"
echo "  ${H1}│${RST}  ${CMD_BG} ${BOLD}${V_CMD}rm${RST}${CMD_BG} ${V_FLAG}-rf${RST}${CMD_BG} ${CMD_W}/${RST}${CMD_BG}                                        ${RST}${HD}│${RST}"
echo "  ${H1}│${RST}  ${EXPL} Recursively deletes everything from root${RST}              ${HD}│${RST}"
echo "  ${H2}│${RST}                                                          ${HD}│${RST}"
echo "  ${H3}│${RST}                                                          ${HD}│${RST}"
echo "  ${H4}│${RST}   ${ACTION}  ${HD}│${RST}"
echo "  ${H5}│${RST}                                                          ${HD}│${RST}"
echo "  ${H6}╰${H7}─${H8}─${H9}─${HD}──────────────────────────────────────────────────────╯${RST}"
echo ""
