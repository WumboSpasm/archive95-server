# Archive95
Archive95 is an unorthodox web archive.

![screenshot](https://github.com/user-attachments/assets/ecb38c89-ce39-40ec-a08b-1a527d7b41ec)

## Dependencies
- A Linux environment with the `file`, `mimetype` and `iconv` utilities
- [Deno](https://deno.com/)
- [ImageMagick](https://imagemagick.org/) (specifically `convert`)
- [uchardet](https://www.freedesktop.org/wiki/Software/uchardet/)

## Instructions
1. Clone repository with `git clone https://github.com/WumboSpasm/archive95-server.git`
2. Create `data` folder in repository root
3. Download [these files](https://archive.org/download/archive95-web-data/data/) into `data` folder, with respect to directory structure
4. Extract all gzipped files into their containing directories
5. Build database with `deno run -A main.js --build`
6. Run server with `deno run -A main.js`

## Endpoints
- `view`: View archived file in repaired form by supplying URL
- `orphan`: View archived file in repaired form by supplying filesystem path
- `raw`: View archived file in raw form by supplying filesystem path
- `inlinks`: View all archived pages that link to the supplied URL
- `options`: Configure behavior of viewer for the supplied URL
- `sources`: View imformation about sources
- `random`: Redirect to a random archived page

## Flags
- `n`: Hide navigation bar
- `p`: Disable presentation improvements for modern browsers
- `f`: Force frameless version of pages
- `w`: Don't point unarchived URLs to Wayback Machine
- `e`: Point all URLs to live internet (overrides `w` flag)
- `m`: Random button includes non-text files
- `o`: Random button includes orphans
