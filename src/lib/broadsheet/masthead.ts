export const LAUNCH_YEAR = 2024;

const ROMAN = [
    ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"],
    ["", "X", "XX", "XXX", "XL", "L", "LX", "LXX", "LXXX", "XC"],
    ["", "C", "CC", "CCC", "CD", "D", "DC", "DCC", "DCCC", "CM"],
    ["M", "MM", "MMM"],
];

function toRoman(n: number): string {
    if (n < 1) return "";
    const digits = String(n).split("").reverse();
    let out = "";
    for (let i = digits.length - 1; i >= 0; i--) {
        const d = Number(digits[i]);
        const table = ROMAN[i];
        if (table && table[d] !== undefined) out += table[d];
    }
    return out;
}

export function computeVolume(year: number): string {
    return toRoman(year - LAUNCH_YEAR + 1);
}

/** Returns the ISO-8601 week number for the given date (1–53). */
export function computeIssueNumber(date: Date): number {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
