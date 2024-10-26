# Archive95
Archive95 is an unorthodox web archive.

## Instructions
1. Install [Bun](https://bun.sh/)
2. Clone repository
3. Make `data` folder and put archive files in it
4. Build database with `bun run main.js build`
5. Run server with `bun run main.js`

## Endpoints
- `view`: View archived file in fixed form by supplying URL
- `orphan`: View archived file in fixed form by supplying filesystem path
- `raw`: View archived file in raw form by supplying filesystem path
- `inlinks`: View all archived pages that link to the supplied URL
- `random`: Redirect to a random archived page

## Flags
- `e`: Point in-page URLs to live internet instead of web archives
- `m`: Random button can take you to any archived URL instead of just pages
- `n`: Disable navigation bar
- `o`: Random button can take you to orphaned files in addition to files with known URLs
- `p`: Disable presentation improvements for modern browsers