#!/bin/bash
# Dialog inspiration gallery — fun variations we explored.
# Run: bash specs/dialog-style-gallery.sh

RST=$'\033[0m'
BOLD=$'\033[1m'
DIM=$'\033[2m'
UL=$'\033[4m'
INV=$'\033[7m'
ITALIC=$'\033[3m'

WHITE=$'\033[38;2;210;210;225m'
HINT=$'\033[38;2;115;115;140m'
HINT_KEY=$'\033[38;2;170;170;195m'
ACCENT_KEY=$'\033[38;2;245;200;100m'
YN_SEP=$'\033[38;2;65;65;80m'
EXPL=$'\033[38;2;135;135;155m'
CMD_BG=$'\033[48;2;35;35;50m'
CMD_W=$'\033[38;2;235;235;245m'
V_CMD=$'\033[38;2;255;180;100m'
V_FLAG=$'\033[38;2;100;220;255m'
V_STR=$'\033[38;2;255;100;180m'

ACTION="${WHITE}Run command?${RST}  ${BOLD}${UL}${ACCENT_KEY}Y${RST}${HINT}es  ${BOLD}${UL}${ACCENT_KEY}N${RST}${HINT}o  ${YN_SEP}│${RST}  ${BOLD}${UL}${HINT_KEY}D${RST}${HINT}escribe  ${BOLD}${UL}${HINT_KEY}E${RST}${HINT}dit  ${BOLD}${UL}${HINT_KEY}F${RST}${HINT}ollow-up  ${BOLD}${UL}${HINT_KEY}C${RST}${HINT}opy${RST}"

# ═══════════════════════════════════════════════════
# Artemis 2: Orion glass cockpit
# ═══════════════════════════════════════════════════
echo ""
echo "  ${BOLD}${WHITE}━━━ Orion glass cockpit ━━━${RST}"
echo ""

OR=$'\033[48;2;5;8;15m'
OR1=$'\033[38;2;0;200;255m'
OR2=$'\033[38;2;0;140;180m'
OR3=$'\033[38;2;0;90;120m'
ORW=$'\033[38;2;200;220;240m'
ORG=$'\033[38;2;0;255;130m'
ORO=$'\033[38;2;255;165;0m'
ORR=$'\033[38;2;255;60;60m'

echo "  ${OR}${OR3}╭─────────────────────────────────────────────────────────────╮${RST}"
echo "  ${OR}${OR3}│${RST}${OR} ${OR1}${BOLD}ORION${RST}${OR}  ${OR3}│${RST}${OR} ${OR2}MET 00:00:00${RST}${OR}  ${OR3}│${RST}${OR} ${OR2}TLI BURN${RST}${OR}  ${OR3}│${RST}${OR} ${ORG}${BOLD}NOMINAL${RST}${OR}       ${OR3}│${RST}"
echo "  ${OR}${OR3}├─────────────────────────────────────────────────────────────┤${RST}"
echo "  ${OR}${OR3}│${RST}${OR}                                                             ${OR3}│${RST}"
echo "  ${OR}${OR3}│${RST}${OR}  ${ORW}${BOLD}CMD QUEUE:${RST}${OR}                                                 ${OR3}│${RST}"
echo "  ${OR}${OR3}│${RST}${OR}  ${OR1}┌───────────────────────────────────────────────────┐${RST}${OR}   ${OR3}│${RST}"
echo "  ${OR}${OR3}│${RST}${OR}  ${OR1}│${RST}${OR} ${ORW}${BOLD}find / -name '*.conf' -delete${RST}${OR}                      ${OR1}│${RST}${OR}   ${OR3}│${RST}"
echo "  ${OR}${OR3}│${RST}${OR}  ${OR1}└───────────────────────────────────────────────────┘${RST}${OR}   ${OR3}│${RST}"
echo "  ${OR}${OR3}│${RST}${OR}  ${OR3}Deletes all .conf files recursively${RST}${OR}                       ${OR3}│${RST}"
echo "  ${OR}${OR3}│${RST}${OR}                                                             ${OR3}│${RST}"
echo "  ${OR}${OR3}│${RST}${OR}  ${ORW}RISK ${ORO}██████████${OR3}░░░░░░░░░░${RST}${OR} ${ORO}MEDIUM${RST}${OR}                         ${OR3}│${RST}"
echo "  ${OR}${OR3}│${RST}${OR}                                                             ${OR3}│${RST}"
echo "  ${OR}${OR3}│${RST}${OR}  ${ORG}${BOLD}▶ EXEC${RST}${OR} ${ORW}${BOLD}${UL}Y${RST}${OR}   ${ORR}${BOLD}■ ABORT${RST}${OR} ${ORW}${BOLD}${UL}N${RST}${OR}   ${OR2}◇ ${ORW}${BOLD}${UL}D${RST}${OR}${OR2}etail   ◇ ${ORW}${BOLD}${UL}E${RST}${OR}${OR2}dit   ◇ ${ORW}${BOLD}${UL}C${RST}${OR}${OR2}opy${RST}${OR}   ${OR3}│${RST}"
echo "  ${OR}${OR3}│${RST}${OR}                                                             ${OR3}│${RST}"
echo "  ${OR}${OR3}╰─────────────────────────────────────────────────────────────╯${RST}"
echo ""

# ═══════════════════════════════════════════════════
# Mission control
# ═══════════════════════════════════════════════════
echo ""
echo "  ${BOLD}${WHITE}━━━ Mission control ━━━${RST}"
echo ""

NA=$'\033[48;2;10;12;20m'
NA1=$'\033[38;2;100;200;255m'
NA2=$'\033[38;2;60;140;180m'
NA3=$'\033[38;2;40;90;120m'
NAG=$'\033[38;2;50;255;100m'
NAR=$'\033[38;2;255;100;60m'
NAW=$'\033[38;2;200;210;220m'

echo "  ${NA}${NA3}┌──────────┬──────────────────────────────────────────────┐${RST}"
echo "  ${NA}${NA3}│ ${NA1}${BOLD}T-00:00  ${RST}${NA}${NA3}│ ${NAW}COMMAND LOADED                                 ${NA3}│${RST}"
echo "  ${NA}${NA3}├──────────┼──────────────────────────────────────────────┤${RST}"
echo "  ${NA}${NA3}│ ${NA2}PAYLOAD  ${NA3}│ ${NAW}${BOLD}find / -name '*.conf' -delete${RST}${NA}                 ${NA3}│${RST}"
echo "  ${NA}${NA3}│ ${NA2}MISSION  ${NA3}│ ${NA2}Delete all .conf files recursively         ${NA3}│${RST}"
echo "  ${NA}${NA3}│ ${NA2}RISK     ${NA3}│ ${NAR}██████████${RST}${NA}${NA3}░░░░░░░░░░ ${NAR}MEDIUM${RST}${NA}              ${NA3}│${RST}"
echo "  ${NA}${NA3}├──────────┴──────────────────────────────────────────────┤${RST}"
echo "  ${NA}${NA3}│                                                         │${RST}"
echo "  ${NA}${NA3}│  ${NAG}${BOLD}GO${RST}${NA} ${NAW}${BOLD}${UL}Y${RST}${NA}${NA2}es    ${NAR}${BOLD}NO-GO${RST}${NA} ${NAW}${BOLD}${UL}N${RST}${NA}${NA2}o    ${NAW}${BOLD}${UL}D${RST}${NA}${NA2}escribe  ${NAW}${BOLD}${UL}E${RST}${NA}${NA2}dit  ${NAW}${BOLD}${UL}F${RST}${NA}${NA2}ollow  ${NAW}${BOLD}${UL}C${RST}${NA}${NA2}opy ${NA3}│${RST}"
echo "  ${NA}${NA3}│                                                         │${RST}"
echo "  ${NA}${NA3}└─────────────────────────────────────────────────────────┘${RST}"
echo ""

# ═══════════════════════════════════════════════════
# Space 2: Deep field, no border
# ═══════════════════════════════════════════════════
echo ""
echo "  ${BOLD}${WHITE}━━━ Deep field, no border ━━━${RST}"
echo ""

S=$'\033[48;2;4;3;12m'
S1=$'\033[38;2;255;255;240m'
S2=$'\033[38;2;180;180;210m'
S3=$'\033[38;2;100;100;140m'
S4=$'\033[38;2;60;55;80m'
NB=$'\033[38;2;50;25;80m'
NB2=$'\033[38;2;35;20;60m'
SC=$'\033[48;2;10;8;22m'
SP_ACC=$'\033[38;2;180;160;255m'

echo "  ${S}                                                              ${RST}"
echo "  ${S}  ${S3}·${RST}${S}     ${S1}✦${RST}${S}        ${S4}·${RST}${S}                 ${S3}·${RST}${S}       ${S1}✦${RST}${S}          ${RST}"
echo "  ${S}       ${S4}·${RST}${S}      ${NB}✧${RST}${S}       ${S2}·${RST}${S}        ${S4}·${RST}${S}                  ${RST}"
echo "  ${S}  ${SC} ${BOLD}${S1}find${RST}${SC} ${S2}/${RST}${SC} ${V_FLAG}-name${RST}${SC} ${SP_ACC}'*.conf'${RST}${SC} ${V_FLAG}-delete${RST}${SC} ${RST}${S}                     ${RST}"
echo "  ${S}  ${S4}Finds and deletes all .conf files recursively${RST}${S}                ${RST}"
echo "  ${S}       ${NB2}·${RST}${S}          ${NB}✧${RST}${S}            ${S4}·${RST}${S}                      ${RST}"
echo "  ${S}  ${S2}Run command?${RST}${S}  ${BOLD}${UL}${S1}Y${RST}${S}${S3}es  ${BOLD}${UL}${S1}N${RST}${S}${S3}o  ${S4}│${RST}${S}  ${BOLD}${UL}${S2}D${RST}${S}${S3}escribe  ${BOLD}${UL}${S2}E${RST}${S}${S3}dit  ${BOLD}${UL}${S2}F${RST}${S}${S3}ollow-up  ${BOLD}${UL}${S2}C${RST}${S}${S3}opy${RST}${S}  ${RST}"
echo "  ${S}          ${S3}·${RST}${S}                    ${S1}✦${RST}${S}              ${S4}·${RST}${S}         ${RST}"
echo "  ${S}  ${S4}·${RST}${S}           ${S2}·${RST}${S}         ${S4}·${RST}${S}              ${NB}✧${RST}${S}              ${RST}"
echo "  ${S}                                                              ${RST}"
echo ""

# ═══════════════════════════════════════════════════
# Submarine command
# ═══════════════════════════════════════════════════
echo ""
echo "  ${BOLD}${WHITE}━━━ Submarine command ━━━${RST}"
echo ""

SB=$'\033[48;2;10;20;30m'
SB1=$'\033[38;2;0;200;200m'
SB2=$'\033[38;2;0;140;140m'
SB3=$'\033[38;2;0;90;90m'
SBW=$'\033[38;2;180;200;210m'
SBR=$'\033[38;2;255;80;80m'

echo "  ${SB}${SB3}  ┌─────────────────────────────────────────────────────┐  ${RST}"
echo "  ${SB}${SB3}  │${RST}${SB} ${SB1}${BOLD}CONN${RST}${SB}  ${SBR}◉ ARM${RST}${SB}  ${SB2}DEPTH: 200m${RST}${SB}         ${SB2}HEADING: 045°${RST}${SB}  ${SB3}│${RST}${SB}  ${RST}"
echo "  ${SB}${SB3}  ├─────────────────────────────────────────────────────┤  ${RST}"
echo "  ${SB}${SB3}  │${RST}${SB}                                                     ${SB3}│${RST}${SB}  ${RST}"
echo "  ${SB}${SB3}  │${RST}${SB}   ${SBW}${BOLD}FIRE ORDER:${RST}${SB}                                       ${SB3}│${RST}${SB}  ${RST}"
echo "  ${SB}${SB3}  │${RST}${SB}   ${SB1}find / -name '*.conf' -delete${RST}${SB}                     ${SB3}│${RST}${SB}  ${RST}"
echo "  ${SB}${SB3}  │${RST}${SB}   ${SB3}Deletes all .conf files from root${RST}${SB}                  ${SB3}│${RST}${SB}  ${RST}"
echo "  ${SB}${SB3}  │${RST}${SB}                                                     ${SB3}│${RST}${SB}  ${RST}"
echo "  ${SB}${SB3}  │${RST}${SB}   ${SBW}CONFIRM LAUNCH?${RST}${SB}                                    ${SB3}│${RST}${SB}  ${RST}"
echo "  ${SB}${SB3}  │${RST}${SB}   ${SBR}${BOLD}[Y]${RST}${SB} ${SB2}FIRE    ${SB1}[N]${RST}${SB} ${SB2}ABORT${RST}${SB}                            ${SB3}│${RST}${SB}  ${RST}"
echo "  ${SB}${SB3}  │${RST}${SB}                                                     ${SB3}│${RST}${SB}  ${RST}"
echo "  ${SB}${SB3}  └─────────────────────────────────────────────────────┘  ${RST}"
echo ""

# ═══════════════════════════════════════════════════
# HTTP response
# ═══════════════════════════════════════════════════
echo ""
echo "  ${BOLD}${WHITE}━━━ HTTP response ━━━${RST}"
echo ""

HT=$'\033[48;2;25;25;35m'
HT_G=$'\033[38;2;100;200;100m'
HT_Y=$'\033[38;2;220;200;100m'
HT_W=$'\033[38;2;200;200;210m'
HT_D=$'\033[38;2;100;100;120m'
HT_K=$'\033[38;2;150;120;200m'

echo "  ${HT}                                                              ${RST}"
echo "  ${HT}  ${HT_G}HTTP/1.1 ${HT_Y}200 AWAITING CONFIRMATION${RST}${HT}                          ${RST}"
echo "  ${HT}  ${HT_K}Content-Type:${RST}${HT} ${HT_D}application/x-shell-command${RST}${HT}                     ${RST}"
echo "  ${HT}  ${HT_K}X-Risk-Level:${RST}${HT} ${HT_Y}medium${RST}${HT}                                        ${RST}"
echo "  ${HT}  ${HT_K}X-Reversible:${RST}${HT} ${HT_D}no${RST}${HT}                                            ${RST}"
echo "  ${HT}                                                              ${RST}"
echo "  ${HT}  ${HT_W}find / -name '*.conf' -delete${RST}${HT}                                ${RST}"
echo "  ${HT}                                                              ${RST}"
echo "  ${HT}  ${HT_D}# Finds and deletes all .conf files recursively${RST}${HT}              ${RST}"
echo "  ${HT}                                                              ${RST}"
echo "  ${HT}  ${HT_G}▸ ${BOLD}${UL}Y${RST}${HT}${HT_D}es  ${HT_W}${BOLD}${UL}N${RST}${HT}${HT_D}o  ${HT_W}${BOLD}${UL}D${RST}${HT}${HT_D}escribe  ${HT_W}${BOLD}${UL}E${RST}${HT}${HT_D}dit  ${HT_W}${BOLD}${UL}F${RST}${HT}${HT_D}ollow-up  ${HT_W}${BOLD}${UL}C${RST}${HT}${HT_D}opy${RST}${HT}              ${RST}"
echo "  ${HT}                                                              ${RST}"
echo ""

# ═══════════════════════════════════════════════════
# Terminal-ception
# ═══════════════════════════════════════════════════
echo ""
echo "  ${BOLD}${WHITE}━━━ Terminal-ception ━━━${RST}"
echo ""

TERM_BG=$'\033[48;2;30;30;30m'
TERM_BAR=$'\033[48;2;50;50;50m\033[38;2;180;180;180m'
TERM_G=$'\033[38;2;80;255;80m'
TERM_W=$'\033[38;2;200;200;200m'
TERM_D=$'\033[38;2;120;120;120m'
TERM_EDGE=$'\033[38;2;70;70;70m'

echo "  ${TERM_EDGE}╭──────────────────────────────────────────────────────────╮${RST}"
echo "  ${TERM_EDGE}│${TERM_BAR} ● ● ●    wrap — confirm                                ${RST}${TERM_EDGE}│${RST}"
echo "  ${TERM_EDGE}│${TERM_BG}                                                          ${RST}${TERM_EDGE}│${RST}"
echo "  ${TERM_EDGE}│${TERM_BG}  ${TERM_G}\$${RST}${TERM_BG} ${TERM_W}find / -name '*.conf' -delete${RST}${TERM_BG}                        ${RST}${TERM_EDGE}│${RST}"
echo "  ${TERM_EDGE}│${TERM_BG}  ${TERM_D}# Finds and deletes all .conf files recursively${RST}${TERM_BG}        ${RST}${TERM_EDGE}│${RST}"
echo "  ${TERM_EDGE}│${TERM_BG}                                                          ${RST}${TERM_EDGE}│${RST}"
echo "  ${TERM_EDGE}│${TERM_BG}  ${TERM_G}Run this command? [y/N]${RST}${TERM_BG} ${BOLD}${TERM_G}█${RST}${TERM_BG}                               ${RST}${TERM_EDGE}│${RST}"
echo "  ${TERM_EDGE}│${TERM_BG}                                                          ${RST}${TERM_EDGE}│${RST}"
echo "  ${TERM_EDGE}╰──────────────────────────────────────────────────────────╯${RST}"
echo ""

# ═══════════════════════════════════════════════════
# VHS tape
# ═══════════════════════════════════════════════════
echo ""
echo "  ${BOLD}${WHITE}━━━ VHS tape ━━━${RST}"
echo ""

VHS=$'\033[48;2;15;15;20m'
VHS_G=$'\033[38;2;120;200;120m'
VHS_D=$'\033[38;2;60;100;60m'
VHS_NOISE=$'\033[38;2;50;50;60m'
VHS_REC=$'\033[38;2;255;40;40m'
VHS_TIME=$'\033[38;2;200;200;200m'

echo "  ${VHS}${VHS_NOISE}▓▒░▒▓▒░░▒▓▒░▒▓▒░░▒▓▒░▒▓▒░░▒▓▒░▒▓▒░░▒▓▒░▒▓▒░░▒▓▒░▒▓▒░░▒▓▒░▒▓${RST}"
echo "  ${VHS}  ${VHS_REC}● REC${RST}${VHS}                                         ${VHS_TIME}00:13:37${RST}${VHS}   ${RST}"
echo "  ${VHS}                                                              ${RST}"
echo "  ${VHS}  ${BOLD}${VHS_G}find${RST}${VHS} ${VHS_D}/${RST}${VHS} ${VHS_D}-name${RST}${VHS} ${VHS_G}'*.conf'${RST}${VHS} ${VHS_D}-delete${RST}${VHS}                        ${RST}"
echo "  ${VHS}  ${VHS_D}Finds and deletes all .conf files recursively${RST}${VHS}                ${RST}"
echo "  ${VHS}                                                              ${RST}"
echo "  ${VHS}  ${VHS_G}PLAY ▶${RST}${VHS}  ${BOLD}${UL}${VHS_G}Y${RST}${VHS}${VHS_D}es   ${VHS_G}STOP ■${RST}${VHS}  ${BOLD}${UL}${VHS_G}N${RST}${VHS}${VHS_D}o${RST}${VHS}                              ${RST}"
echo "  ${VHS}                                                              ${RST}"
echo "  ${VHS}${VHS_NOISE}░▒▓▒░░▒▓▒░▒▓▒░░▒▓▒░▒▓▒░░▒▓▒░▒▓▒░░▒▓▒░▒▓▒░░▒▓▒░▒▓▒░░▒▓▒░▒▓▒░${RST}"
echo ""

# ═══════════════════════════════════════════════════
# Windows XP Luna
# ═══════════════════════════════════════════════════
echo ""
echo "  ${BOLD}${WHITE}━━━ Windows XP Luna ━━━${RST}"
echo ""

XP_TITLE=$'\033[48;2;0;84;227m\033[38;2;255;255;255m'
XP_BG=$'\033[48;2;236;233;216m\033[38;2;0;0;0m'
XP_X=$'\033[48;2;210;60;50m\033[38;2;255;255;255m'
XP_EDGE=$'\033[38;2;0;84;227m'
XP_BBORDER=$'\033[38;2;0;60;160m'

echo "  ${XP_EDGE}╭──────────────────────────────────────────────────────────╮${RST}"
echo "  ${XP_EDGE}│${XP_TITLE}${BOLD} ⚠ Confirm Execution                              ${RST}${XP_X}${BOLD} ✕ ${RST}${XP_EDGE}│${RST}"
echo "  ${XP_EDGE}├──────────────────────────────────────────────────────────┤${RST}"
echo "  ${XP_EDGE}│${XP_BG}                                                          ${RST}${XP_EDGE}│${RST}"
echo "  ${XP_EDGE}│${XP_BG}   ⚠  find / -name '*.conf' -delete                      ${RST}${XP_EDGE}│${RST}"
echo "  ${XP_EDGE}│${XP_BG}                                                          ${RST}${XP_EDGE}│${RST}"
echo "  ${XP_EDGE}│${XP_BG}   Finds and deletes all .conf files recursively           ${RST}${XP_EDGE}│${RST}"
echo "  ${XP_EDGE}│${XP_BG}                                                          ${RST}${XP_EDGE}│${RST}"
echo "  ${XP_EDGE}│${XP_BG}          ${XP_BBORDER}╭──────────╮${RST}${XP_BG}  ${XP_BBORDER}╭──────────╮${RST}${XP_BG}                    ${RST}${XP_EDGE}│${RST}"
echo "  ${XP_EDGE}│${XP_BG}          ${XP_BBORDER}│${RST}${XP_BG}${BOLD}   Yes    ${RST}${XP_BG}${XP_BBORDER}│${RST}${XP_BG}  ${XP_BBORDER}│${RST}${XP_BG}    No    ${XP_BBORDER}│${RST}${XP_BG}                    ${RST}${XP_EDGE}│${RST}"
echo "  ${XP_EDGE}│${XP_BG}          ${XP_BBORDER}╰──────────╯${RST}${XP_BG}  ${XP_BBORDER}╰──────────╯${RST}${XP_BG}                    ${RST}${XP_EDGE}│${RST}"
echo "  ${XP_EDGE}│${XP_BG}                                                          ${RST}${XP_EDGE}│${RST}"
echo "  ${XP_EDGE}╰──────────────────────────────────────────────────────────╯${RST}"
echo ""

# ═══════════════════════════════════════════════════
# Windows 3.1
# ═══════════════════════════════════════════════════
echo ""
echo "  ${BOLD}${WHITE}━━━ Windows 3.1 ━━━${RST}"
echo ""

W31_BG=$'\033[48;2;255;255;255m\033[38;2;0;0;0m'
W31_TITLE=$'\033[48;2;0;0;128m\033[38;2;255;255;255m'
W31_EDGE=$'\033[38;2;128;128;128m'

echo "  ${W31_EDGE}╔══════════════════════════════════════════════════════════╗${RST}"
echo "  ${W31_EDGE}║${W31_TITLE}${BOLD}  Confirm Command                                       ${RST}${W31_EDGE}║${RST}"
echo "  ${W31_EDGE}╠══════════════════════════════════════════════════════════╣${RST}"
echo "  ${W31_EDGE}║${W31_BG}                                                          ${RST}${W31_EDGE}║${RST}"
echo "  ${W31_EDGE}║${W31_BG}       find / -name '*.conf' -delete                      ${RST}${W31_EDGE}║${RST}"
echo "  ${W31_EDGE}║${W31_BG}                                                          ${RST}${W31_EDGE}║${RST}"
echo "  ${W31_EDGE}║${W31_BG}       Finds and deletes all .conf files                   ${RST}${W31_EDGE}║${RST}"
echo "  ${W31_EDGE}║${W31_BG}                                                          ${RST}${W31_EDGE}║${RST}"
echo "  ${W31_EDGE}║${W31_BG}         ╔══════════╗    ╔══════════╗                      ${RST}${W31_EDGE}║${RST}"
echo "  ${W31_EDGE}║${W31_BG}         ║   ${BOLD}OK${RST}${W31_BG}     ║    ║  Cancel  ║                      ${RST}${W31_EDGE}║${RST}"
echo "  ${W31_EDGE}║${W31_BG}         ╚══════════╝    ╚══════════╝                      ${RST}${W31_EDGE}║${RST}"
echo "  ${W31_EDGE}║${W31_BG}                                                          ${RST}${W31_EDGE}║${RST}"
echo "  ${W31_EDGE}╚══════════════════════════════════════════════════════════╝${RST}"
echo ""

# ═══════════════════════════════════════════════════
# Windows 95 dialog
# ═══════════════════════════════════════════════════
echo ""
echo "  ${BOLD}${WHITE}━━━ Windows 95 dialog ━━━${RST}"
echo ""

W_TITLE=$'\033[48;2;0;0;128m\033[38;2;255;255;255m'
W_BG=$'\033[48;2;192;192;192m\033[38;2;0;0;0m'
W_BORDER=$'\033[38;2;255;255;255m'

echo "  ${W_BORDER}┌──────────────────────────────────────────────────────────┐${RST}"
echo "  ${W_BORDER}│${W_TITLE}${BOLD} ⚠ Confirm Command                                      ${RST}${W_BORDER}│${RST}"
echo "  ${W_BORDER}├──────────────────────────────────────────────────────────┤${RST}"
echo "  ${W_BORDER}│${W_BG}                                                          ${RST}${W_BORDER}│${RST}"
echo "  ${W_BORDER}│${W_BG}  ⚠  find / -name '*.conf' -delete                       ${RST}${W_BORDER}│${RST}"
echo "  ${W_BORDER}│${W_BG}                                                          ${RST}${W_BORDER}│${RST}"
echo "  ${W_BORDER}│${W_BG}  Finds and deletes all .conf files recursively            ${RST}${W_BORDER}│${RST}"
echo "  ${W_BORDER}│${W_BG}                                                          ${RST}${W_BORDER}│${RST}"
echo "  ${W_BORDER}│${W_BG}         ┌────────┐  ┌────────┐  ┌────────┐              ${RST}${W_BORDER}│${RST}"
echo "  ${W_BORDER}│${W_BG}         │${BOLD}  Yes   ${RST}${W_BG}│  │   No   │  │  Help  │              ${RST}${W_BORDER}│${RST}"
echo "  ${W_BORDER}│${W_BG}         └────────┘  └────────┘  └────────┘              ${RST}${W_BORDER}│${RST}"
echo "  ${W_BORDER}│${W_BG}                                                          ${RST}${W_BORDER}│${RST}"
echo "  ${W_BORDER}└──────────────────────────────────────────────────────────┘${RST}"
echo ""

# ═══════════════════════════════════════════════════
# macOS Aqua dialog
# ═══════════════════════════════════════════════════
echo ""
echo "  ${BOLD}${WHITE}━━━ macOS Aqua dialog ━━━${RST}"
echo ""

MAC_BG=$'\033[48;2;232;232;232m\033[38;2;40;40;40m'
MAC_TITLE=$'\033[48;2;210;210;210m\033[38;2;60;60;60m'
MAC_RED=$'\033[38;2;255;95;87m'
MAC_YEL=$'\033[38;2;255;189;46m'
MAC_GRN=$'\033[38;2;39;201;63m'
MAC_BTN=$'\033[48;2;0;122;255m\033[38;2;255;255;255m'
MAC_BTN2=$'\033[48;2;232;232;232m\033[38;2;40;40;40m'
MAC_EDGE=$'\033[38;2;190;190;190m'

echo "  ${MAC_EDGE}╭──────────────────────────────────────────────────────────╮${RST}"
echo "  ${MAC_EDGE}│${MAC_TITLE} ${MAC_RED}●${RST}${MAC_TITLE} ${MAC_YEL}●${RST}${MAC_TITLE} ${MAC_GRN}●${RST}${MAC_TITLE}          ${BOLD}Confirm Execution${RST}${MAC_TITLE}                       ${RST}${MAC_EDGE}│${RST}"
echo "  ${MAC_EDGE}├──────────────────────────────────────────────────────────┤${RST}"
echo "  ${MAC_EDGE}│${MAC_BG}                                                          ${RST}${MAC_EDGE}│${RST}"
echo "  ${MAC_EDGE}│${MAC_BG}    ⚠  Are you sure you want to run this command?         ${RST}${MAC_EDGE}│${RST}"
echo "  ${MAC_EDGE}│${MAC_BG}                                                          ${RST}${MAC_EDGE}│${RST}"
echo "  ${MAC_EDGE}│${MAC_BG}    find / -name '*.conf' -delete                         ${RST}${MAC_EDGE}│${RST}"
echo "  ${MAC_EDGE}│${MAC_BG}                                                          ${RST}${MAC_EDGE}│${RST}"
echo "  ${MAC_EDGE}│${MAC_BG}                          ${MAC_BTN2}┌──────────┐${RST}${MAC_BG}  ${MAC_BTN}${BOLD}┌──────────┐${RST}${MAC_BG}    ${RST}${MAC_EDGE}│${RST}"
echo "  ${MAC_EDGE}│${MAC_BG}                          ${MAC_BTN2}│  Cancel  │${RST}${MAC_BG}  ${MAC_BTN}${BOLD}│   Run    │${RST}${MAC_BG}    ${RST}${MAC_EDGE}│${RST}"
echo "  ${MAC_EDGE}│${MAC_BG}                          ${MAC_BTN2}└──────────┘${RST}${MAC_BG}  ${MAC_BTN}${BOLD}└──────────┘${RST}${MAC_BG}    ${RST}${MAC_EDGE}│${RST}"
echo "  ${MAC_EDGE}│${MAC_BG}                                                          ${RST}${MAC_EDGE}│${RST}"
echo "  ${MAC_EDGE}╰──────────────────────────────────────────────────────────╯${RST}"
echo ""
