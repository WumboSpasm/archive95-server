// Make sure links inside frames inside iframes update the window context they're supposed to
function changeLinkTargets() {
	for (const link of document.querySelectorAll('[href]')) {
		if (link.target == '_parent' || !link.href.startsWith(location.origin))
			link.target = '_top';
	}
}

document.addEventListener('DOMContentLoaded', changeLinkTargets);