// If specially-flagged frame content is being displayed in a normal browser window, remove the flags from the URL so the navigation bar is shown
if (window.top == window.self && window.menubar.visible)
	location.replace(location.href.replace(/(?<=^https?:\/\/[^/]+\/+[^/]+)(_[^/]+)(?=\/)/, flagIds => flagIds.replace(/[ijk]/g, '').replace(/^_$/, '')));