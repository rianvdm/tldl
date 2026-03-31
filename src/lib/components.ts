import { html } from "hono/html";

/**
 * Shared footer component used across all pages
 */
export const Footer = html`
    <footer class="footer">
        <p><a href="/request">Request a Podcast</a> | <a href="https://github.com/rianvdm/tldl/issues" target="_blank" rel="noopener noreferrer">Submit a Bug</a> | <a href="/about#creator-opt-out">Creator Opt-out</a> | <a href="/admin">Admin</a></p>
    </footer>
`;
