import { html } from "hono/html";

/**
 * Shared footer component used across all pages
 */
export const Footer = html`
    <footer class="footer">
        <p><a href="/request">Request a Podcast</a> | <a href="https://elezea.com/contact/" target="_blank" rel="noopener noreferrer">Feedback</a> | <a href="/about#creator-opt-out">Creator Opt-out</a></p>
    </footer>
`;
