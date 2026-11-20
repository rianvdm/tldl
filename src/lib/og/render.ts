import { satori } from "@cf-wasm/satori";
import { Resvg } from "@cf-wasm/resvg";
import type { CardModel } from "./card-model";
import { buildCardTree, CARD_HEIGHT, CARD_WIDTH } from "./card-tree";
import { cardFonts } from "./fonts";

/** The card as SVG, with text drawn as glyph paths (satori's output). */
export function renderCardSvg(model: CardModel): Promise<string> {
    return satori(buildCardTree(model), { width: CARD_WIDTH, height: CARD_HEIGHT, fonts: cardFonts() });
}

/** Draws an episode's share card: element tree → SVG (satori) → PNG (resvg). */
export async function renderCardPng(model: CardModel): Promise<Uint8Array> {
    const svg = await renderCardSvg(model);
    // resvg's handles hold wasm memory that the JS GC doesn't reclaim; free them.
    const resvg = await Resvg.async(svg);
    try {
        const image = resvg.render();
        try {
            return image.asPng();
        } finally {
            image.free();
        }
    } finally {
        resvg.free();
    }
}
