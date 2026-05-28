# Archive95
 Archive95 is an independent web archive focused on material that predates or has otherwise evaded more mainstream archives.

![screenshot](https://github.com/user-attachments/assets/ecb38c89-ce39-40ec-a08b-1a527d7b41ec)

## Dependencies
- A Linux environment
- [Deno](https://deno.com/)
- The following command-line utilities:
  - `mimetype` (the `IO::Scalar` Perl library is also needed for stdin support)
  - `iconv`
  - `convert` (from [ImageMagick](https://imagemagick.org/))
  - `uchardet`

If building with the `--vhd` flag:
- Support for the [XFS](https://en.wikipedia.org/wiki/XFS) filesystem
- The following command-line utilities:
  - `qemu-img`
  - `virt-format`
  - `guestmount`
  - `guestunmount`

## Instructions
1. Clone the repository with `git clone https://github.com/WumboSpasm/archive95-server.git`
2. Download the latest revision of the dataset from [here](https://archive.org/details/archive95-dataset) and extract into the `data` folder
3. Build the filesystem and search database with `deno run -A build.js`
   - Note that this will take a long time (>2 hours on a relatively beefy machine) although subsequent builds should be much faster (~20 minutes on the same machine)
   - Also note that this will create millions of inodes. You can relegate them to a virtual hard disk using the `--vhd` flag
4. Run the server with `deno run -A main.js`

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