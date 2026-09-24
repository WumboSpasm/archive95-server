# Archive95
Archive95 is an independent web archive focused on material that predates or has otherwise evaded more mainstream archives.

![screenshot](https://github.com/user-attachments/assets/b3a6ae33-b135-4506-b933-4c262527cd20)

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
   - Note that this will take a ***very*** long time by default; [see below](#feature-options) for information on features that can be turned off to speed up the build process
5. Run the server with `deno task start`

## Command-Line Flags

### General
- `--config=<path>` - Load a config file at the specified path
   - Default is `config.json` in the repository root, or `data/config_template.json` if it does not exist

### Build
- `--clean` - Perform a clean build

## Configuration Options
A template configuration file containing the default values of each option can be found at `data/config_template.json`.

- `httpPort` - The HTTP port on which to start the server
- `httpsPort` - The HTTPS port on which to start the server if `httpsCert` and `httpsKey` are specified
- `httpsCert` - The file path of the TLS certificate needed to start the server on HTTPS
- `httpsKey` - The file path of the TLS private key needed to start the server on HTTPS
- `accessHosts` - An array of hostnames through which connections are allowed; if empty, all hostnames are allowed
- `inputPath` - The directory of an extracted [Archive95 dataset](https://archive.org/details/archive95-dataset) from which the server database and file tree will be built
- `buildPath` - The directory of the built server database and file tree
- `buildLogFile` - The file path to which build log entries should be saved
- `serverLogFile` - The file path to which server log entries should be saved
- `blocklistFile` - The file path to the blocklist
- `honeypotFile` - The file path to which IP addresses caught in the honeypot should be saved
- `logToConsole` - Controls if log entries should appear in the console
- `logBlockedRequests` - Controls if blocked requests should be logged
- `buildFeatures` - An array of strings denoting which features should be made available via the build process; [see below](#feature-options) for a full list of features
- `doModernMode` - Controls if modern browsers should be served an enhanced HTML5 frontend
- `doHoneypot` - Controls if the options page should contain hidden honeypot links which will permanently log IP addresses to a `honeypot.txt` file
- `doHoneypotBlock` - Controls if requests from IP addresses caught in the honeypot should be blocked
- `shutdownTimeout` - The amount of milliseconds to wait before forcefully shutting down the server
- `randomCacheSize` - The amount of random pages to store in memory before querying the search database again
- `resultsPerPage` - The maximum amount of search results that can be displayed on a single page
- `maxPage` - The maximum amount of pages of search results that can be retrieved in a search query

### Feature Options
- `database` - Enables the creation of a database file providing full-text search functionality and the random button
   - Turning this off will cause the search box to process only exact URL matches, similar to the Wayback Machine
- `smartTypes` - Enables the identification of file types using a slow but highly reliable method
   - Turning this off will decrease the initial build time by orders of magnitude, but subsequent builds will be identical in speed regardless of how this option is set
- `screenshots` - Enables vintage page screenshots to be accessible from the navigation bar where available
   - Turning this off will produce a noticeable difference in build time only if it is already relatively short
- `presentation` - Enables the creation of fixed/converted versions of files, to be served when the presentation improvements flag is active
   - Turning this off will prevent most audio/video files from being playable in modern browsers, and will remove the presentation improvements flag in compatibility mode
- `browse` - Enables the directory browser
   - Turning this off will moderately decrease the total amount of build files
- `inlinks` - Enables the inlinks page
   - Turning this off will significantly decrease the total amount of build files
- `symlinks` - Enables the creation of symlinks to the input paths of unchanged archive files
   - Turning this on will significantly decrease the total build size, but will create a post-build dependency on the input directory

## Endpoints
- `view` - View archived file
- `raw` - View archived file in raw form
- `browse` - View contents of a supplied directory
- `inlinks` - View all archived pages that link to the supplied URL
- `options` - Configure behavior of viewer
- `screenshot` - View archived screenshot
- `thumbnail` - View archived screenshot at a small resolution
- `random` - Redirect to a random archived file
- `api` - Get information about the archive in JSON format
   - See the "API Endpoints" section for more information
- `about` - Learn about Archive95
- `sources` - View information about data sources

## Flags
- `n` - Hide navigation bar
- `p` - Disable presentation improvements
- `d` - Render navigation bar inline
- `f` - Render page content without frames
- `s` - Render page content without JavaScript
- `w` - Don't point unarchived URLs to Wayback Machine
- `r` - Display error pages in navigation bar
- `m` - Random button includes non-HTML files
- `o` - Random button excludes orphans

### Technical Flags
- `i` - Render iframe-ready page content
- `j` - Render iframe-ready frame content
- `k` - Render frame content for inline navigation bar

### Commodity Flags
- `e` - Point all URLs to live internet

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
