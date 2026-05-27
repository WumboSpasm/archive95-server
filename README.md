# Archive95
Archive95 is an independent web archive using old CD-ROMs and other material as sources.

![screenshot](https://github.com/user-attachments/assets/ecb38c89-ce39-40ec-a08b-1a527d7b41ec)

## Dependencies
- A Linux environment with the `mimetype` and `iconv` utilities and the `IO::Scalar` Perl library
- [Deno](https://deno.com/)
- [ImageMagick](https://imagemagick.org/) (specifically `convert`)
- [uchardet](https://www.freedesktop.org/wiki/Software/uchardet/)

## Instructions
1. Clone repository with `git clone https://github.com/WumboSpasm/archive95-server.git`
2. Download the latest revision of the dataset from [here](https://archive.org/details/archive95-dataset) and extract into the `data` folder
3. Build filesystem and search database with `deno run -A build.js` (this will take a long time)
4. Run server with `deno run -A main.js`

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
- `r`: Display error pages in navigation bar
- `m`: Random button includes non-HTML files
- `o`: Random button excludes orphans