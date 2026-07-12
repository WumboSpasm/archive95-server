# Archive95
 Archive95 is an independent web archive focused on material that predates or has otherwise evaded more mainstream archives.

![screenshot](https://github.com/user-attachments/assets/ecb38c89-ce39-40ec-a08b-1a527d7b41ec)

## Dependencies
- A Linux environment
- [Deno](https://deno.com/)
- The following command-line utilities:
   - `mimetype` (the `IO::Scalar` Perl library is also required for stdin support)
   - `uchardet`
   - `iconv`
   - `convert` (from [ImageMagick](https://imagemagick.org/))
   - `ffmpeg` (the `libx264` library is also required for H.264 encoding)

## Instructions
1. Clone the repository with `git clone https://github.com/WumboSpasm/archive95-server.git`
2. Download the latest revision of the dataset from [here](https://archive.org/details/archive95-dataset) and extract into the `data` folder
3. Install package dependencies with `deno install`
4. Build the filesystem and search database with `deno task build`
   - Note that this will take a long time (>2 hours on a relatively beefy machine) although subsequent builds should be much faster (~20 minutes on the same machine)
   - Also note that this will create millions of inodes
5. Run the server with `deno task start`

## Command-Line Flags

### General
- `--config=<path>` - Load a config file at the specified path
   - Default is `config.json` in the repository root, or `data/config_template.json` if it does not exist

### Build Only
- `--clean` - Perform a clean build

## Endpoints
- `view`: View archived file
- `raw`: View archived file in raw form
- `browse`: View contents of a supplied directory
- `inlinks`: View all archived pages that link to the supplied URL
- `options`: Configure behavior of viewer
- `screenshot`: View archived screenshot
- `thumbnail`: View archived screenshot at a small resolution
- `random`: Redirect to a random archived file
- `api`: Get information about the archive in JSON format
   - See the "API Endpoints" section for more information
- `about`: Learn about Archive95
- `sources`: View information about sources

## Flags
- `n`: Hide navigation bar
- `p`: Disable presentation improvements
- `d`: Render navigation bar inline
- `f`: Render page content without frames
- `w`: Don't point unarchived URLs to Wayback Machine
- `r`: Display error pages in navigation bar
- `m`: Random button includes non-HTML files
- `o`: Random button excludes orphans

### Technical Flags
- `i`: Render iframe-ready page content
- `j`: Render iframe-ready frame content
- `k`: Render frame content for inline navigation bar

### Commodity Flags
- `e`: Point all URLs to live internet

## API Endpoints
- `api/search` - Return search results
   - `query` (required) - A search query
   - `source` - A source ID by which to filter results
   - `in` - A field by which to filter results; possible values are `title`, `content`, and `url`
      - This parameter can be defined multiple times with different values
   - `formats` - A file format group by which to filter results; possible values are `all`, `text`, and `media`
- `api/archives` - Return all archives belonging to a URL
   - `url` (required) - A URL or orphan file path
   - `source` - If `url` is an orphan file path, then this is the source ID that it belongs to
- `api/get` - Return detailed information about an archive
   - `url` (required) - The archive's URL or orphan file path
   - `source` - The archive's source ID; required if the archive is an orphan
   - `offset` - If there are multiple archives with the same `url` and `source` value, then this is a number denoting the archive's offset
   - `p` - If this has a value of `true`, then the returned search/inject info reflects the presentation improvements flag
- `api/browse` - Return contents of a directory
   - `url` - A URL or orphan path denoting a directory; required if no source ID is specified
   - `source` - A source ID by which to filter directory contents; required if `url` is an orphan path or not specified
- `api/inlinks` - Return all archives which link to a URL
   - `url` (required) - A URL or orphan file path
   - `source` - If `url` is an orphan file path, then this is the source ID that it belongs to