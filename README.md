# Archive95
Archive95 is an independent web archive using old CD-ROMs and other material as sources.

![screenshot](https://github.com/user-attachments/assets/ecb38c89-ce39-40ec-a08b-1a527d7b41ec)

## Dependencies
- A Linux environment with the `file`, `mimetype` and `iconv` utilities
- [Deno](https://deno.com/)
- [ImageMagick](https://imagemagick.org/) (specifically `convert`)
- [uchardet](https://www.freedesktop.org/wiki/Software/uchardet/)

## Instructions
1. Clone repository with `git clone https://github.com/WumboSpasm/archive95-server.git`
2. Inside `data`, create a folder named `input`
3. Download [these files](https://archive.org/download/archive95-web-data/input/) into the `input` folder you just created
4. Extract all gzipped files into their respective folders
5. Build filesystem and search database with `deno run -A build.js` (this will take a long time)
6. Run server with `deno run -A main.js`

## Endpoints
- `view`: View archived file in repaired form
- `raw`: View archived file in raw form
- `inlinks`: View all archived pages that link to the supplied URL
- `options`: Configure behavior of viewer
- `screenshot`: View archived screenshot
- `thumbnail`: View archived screenshot at a small resolution
- `random`: Redirect to a random archived file
- `sources`: View imformation about sources

## Flags
- `n`: Hide navigation bar
- `p`: Disable presentation improvements
- `f`: Force frameless version of pages
- `w`: Don't point unarchived URLs to Wayback Machine
- `e`: Point all URLs to live internet (overrides `w` flag)
- `m`: Random button includes non-HTML files
- `o`: Random button excludes orphans