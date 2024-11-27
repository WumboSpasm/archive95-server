# Archive95
Archive95 is an unorthodox web archive.

![screenshot](https://github.com/user-attachments/assets/de7a7bb2-39c2-4121-9778-dff28d8e7af0)

## Dependencies
- A Linux environment with the `file`, `mimetype` and `iconv` utilities
- [Deno](https://deno.com/)
- [ImageMagick](https://imagemagick.org/) (specifically `convert`)
- [uchardet](https://www.freedesktop.org/wiki/Software/uchardet/)

## Instructions
1. Clone repository with `git clone https://github.com/WumboSpasm/archive95-server.git`
2. Make `data` folder and put archive files in it (download coming soon)
3. Build database with `deno run -A main.js --build`
4. Run server with `deno run -A main.js`

## Endpoints
- `view`: View archived file in repaired form by supplying URL
- `orphan`: View archived file in repaired form by supplying filesystem path
- `raw`: View archived file in raw form by supplying filesystem path
- `inlinks`: View all archived pages that link to the supplied URL
- `random`: Redirect to a random archived page

## Flags
- `e`: Point in-page URLs to live internet instead of web archives
- `m`: Random button can take you to any archived URL instead of just pages
- `n`: Disable navigation bar
- `o`: Random button can take you to orphaned files in addition to files with known URLs
- `p`: Disable presentation improvements for modern browsers
