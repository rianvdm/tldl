import frauncesSemiBold from "../../assets/fonts/Fraunces-SemiBold.ttf";
import frauncesBlackItalic from "../../assets/fonts/Fraunces-BlackItalic.ttf";
import frauncesItalic from "../../assets/fonts/Fraunces-Italic.ttf";
import jetBrainsMonoMedium from "../../assets/fonts/JetBrainsMono-Medium.ttf";

export const SERIF = "Fraunces";
export const MONO = "JetBrains Mono";

export interface CardFont {
    name: string;
    data: ArrayBuffer;
    weight: 400 | 600 | 900 | 500;
    style: "normal" | "italic";
}

// Data-module imports are evaluated once per isolate, so these buffers are
// shared by every render rather than reloaded per request.
const FONTS: CardFont[] = [
    { name: SERIF, data: frauncesSemiBold, weight: 600, style: "normal" },
    { name: SERIF, data: frauncesBlackItalic, weight: 900, style: "italic" },
    { name: SERIF, data: frauncesItalic, weight: 400, style: "italic" },
    { name: MONO, data: jetBrainsMonoMedium, weight: 500, style: "normal" },
];

/** The four static TTFs the share card is drawn with. */
export function cardFonts(): CardFont[] {
    return FONTS;
}
