// For frames inside iframes, in-site links that target the parent browsing context as well as all Wayback Machine links need to be re-targeted to the topmost browsing context
// - In the former's case, this is to prevent links that intend to change the page URL from only changing the iframe
// - In the latter's case, it's because embedding content from the Wayback Machine is generally not a good idea
// The "j" flag ID also needs to be removed from in-site links so the page doesn't display without a navigation bar
function updateLinks() {
	for (const link of document.querySelectorAll('[href^="/view-"][target], [href^="http://"]')) {
		const href = link.getAttribute('href');
		if (href.startsWith('/view-')) {
			if (link.target != '_parent' && link.target != '_top' && link.target != '_blank')
				continue;

			link.setAttribute('href', href.replace(/(?<=^\/.*?)(_.*?)(?=\/)/, flagIds => flagIds == '_j' ? '' : flagIds.replace('j', '')));
		}

		if (link.target != '_blank')
			link.target = '_top';
	}
}

document.addEventListener('DOMContentLoaded', updateLinks);