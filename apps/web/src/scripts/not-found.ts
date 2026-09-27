/**
 * 404 page: static hosts cannot serve /jastipkita/app/transactions/<id> or /jastipkita/r/<code>; forward them to the
 * static fallback pages with the value in the query string (validated again on the target page).
 * External module (no inline script) so the page works under the site CSP.
 */
const p = location.pathname;
const tx = /^\/jastipkita\/app\/transactions\/([^/?#]+)\/?$/.exec(p);
const ref = /^\/jastipkita\/r\/([^/?#]+)\/?$/.exec(p);
if (tx?.[1]) location.replace(`/jastipkita/app/transactions/?id=${encodeURIComponent(decodeURIComponent(tx[1]))}`);
else if (ref?.[1]) location.replace(`/jastipkita/r/?code=${encodeURIComponent(decodeURIComponent(ref[1]))}`);

export {};
