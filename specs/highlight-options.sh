#!/bin/bash
# Preview highlight styles for the selected action bar item.
# Run: bash specs/highlight-options.sh

ESC='\033['
R="${ESC}0m"

# Palette
WARM_KEY="${ESC}1;4;38;2;245;200;100m"   # bold+underline warm accent (shortcut letter)
COOL_KEY="${ESC}1;4;38;2;170;170;195m"   # bold+underline cool accent
DIM="${ESC}38;2;115;115;140m"            # dim label rest
PROMPT="${ESC}38;2;210;210;225m"         # "Run command?" text
SEP="${ESC}38;2;65;65;80m"              # separator │

# Unselected action rendering helpers
no()       { printf "${WARM_KEY}N${R}${DIM}o${R}"; }
yes()      { printf "${WARM_KEY}Y${R}${DIM}es${R}"; }
describe() { printf "${COOL_KEY}D${R}${DIM}escribe${R}"; }
edit()     { printf "${COOL_KEY}E${R}${DIM}dit${R}"; }
followup() { printf "${COOL_KEY}F${R}${DIM}ollow-up${R}"; }
copy()     { printf "${COOL_KEY}C${R}${DIM}opy${R}"; }

bar_prefix() { printf "   ${PROMPT}Run command?${R}  "; }
bar_sep()    { printf "  ${SEP}|${R}  "; }
bar_gap()    { printf "  "; }

# Full unselected bar for reference
full_bar() {
  bar_prefix; no; bar_gap; yes; bar_sep; describe; bar_gap; edit; bar_gap; followup; bar_gap; copy
  echo
}

# ── Styles ──────────────────────────────────────────────────────────

echo
echo "  Current style (barely visible brightness bump):"
echo -n "  "; full_bar
echo

styles=(
  "1. Bright white text"
  "2. Background pill (dark purple)"
  "3. Background pill (warm amber)"
  "4. Inverse video"
  "5. Full underline + bright"
  "6. Arrow indicator  \xe2\x96\xb8"
  "7. Bracket indicator [ ]"
  "8. Bold bright + colored bg"
)

# Each style renders "No" as the selected item in slot 1
for i in "${!styles[@]}"; do
  n=$((i + 1))
  echo "  ${styles[$i]}:"
  echo -n "  "
  bar_prefix

  case $n in
    1) # Bright white text for full word
      printf "${ESC}1;4;38;2;245;200;100m""N${R}${ESC}1;38;2;255;255;255m""o${R}"
      ;;
    2) # Dark purple bg pill
      printf "${ESC}48;2;60;50;90m ${ESC}1;4;38;2;245;200;100m""N${R}${ESC}48;2;60;50;90;38;2;200;200;220m""o ${R}"
      ;;
    3) # Warm amber bg pill
      printf "${ESC}48;2;80;60;20m ${ESC}1;4;38;2;245;200;100m""N${R}${ESC}48;2;80;60;20;38;2;230;210;160m""o ${R}"
      ;;
    4) # Inverse video
      printf "${ESC}7;1;4;38;2;245;200;100m""N${R}${ESC}7;38;2;200;200;220m""o${R}"
      ;;
    5) # Full underline + bright
      printf "${ESC}1;4;38;2;245;200;100m""N${R}${ESC}4;38;2;220;220;240m""o${R}"
      ;;
    6) # Arrow indicator
      printf "${ESC}38;2;245;200;100m""\xe2\x96\xb8${R}${WARM_KEY}N${R}${DIM}o${R}"
      ;;
    7) # Bracket indicator
      printf "${ESC}38;2;100;100;130m""[${R}${WARM_KEY}N${R}${DIM}o${R}${ESC}38;2;100;100;130m""]${R}"
      ;;
    8) # Bold bright + colored bg
      printf "${ESC}48;2;55;45;80m ${ESC}1;4;38;2;255;220;120m""N${R}${ESC}48;2;55;45;80;1;38;2;235;230;250m""o ${R}"
      ;;
  esac

  bar_gap; yes; bar_sep; describe; bar_gap; edit; bar_gap; followup; bar_gap; copy
  echo
  echo
done
