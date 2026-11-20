/** Episode runtime as the Broadsheet pages show it: "1h 12m", "2h 05m", "45m". */
export function formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m.toString().padStart(2, "0")}m` : `${m}m`;
}
