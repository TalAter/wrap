import { Text } from "ink";
import { isNerdFonts } from "../core/output.ts";
import { type BadgeColors, themeHex } from "../core/theme.ts";

export function pillEdges(): { left: string; right: string } {
  return isNerdFonts() ? { left: "\uE0B6", right: "\uE0B4" } : { left: "", right: "" };
}

export type PillProps = BadgeColors & {
  icon?: string;
  label: string;
  bold?: boolean;
};

export function Pill({ icon, label, fg, bg, bold }: PillProps) {
  const fgHex = themeHex(fg);
  const bgHex = themeHex(bg);
  const nerd = isNerdFonts();
  const inner = icon ? `${icon} ${label}` : label;
  const body = nerd ? inner : ` ${inner} `;
  return (
    <Text>
      {nerd ? <Text color={bgHex}>{"\uE0B6"}</Text> : null}
      <Text color={fgHex} backgroundColor={bgHex} bold={bold}>
        {body}
      </Text>
      {nerd ? <Text color={bgHex}>{"\uE0B4"}</Text> : null}
    </Text>
  );
}
