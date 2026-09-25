// For frames inside iframes, links that target the parent browsing context as well as all Wayback Machine links need to be re-targeted to the topmost browsing context
// - In the former's case, this is to prevent links that intend to change the page URL from only changing the iframe URL
// - In the latter's case, this is because embedding content from the Wayback Machine is generally not a good idea
function updateLinks() {
	for (const link of document.querySelectorAll('[href^="/view-"][target],[href="/deadend"][target],[href^="http://web.archive.org/"]')) {
		const href = link.getAttribute('href');
		if ((href.startsWith('/view-') || href == '/deadend') && link.target == '_parent' && window.parent.parent == window.top || href.startsWith('http://web.archive.org/'))
			link.target = '_top';
	}
}

document.addEventListener('DOMContentLoaded', updateLinks);