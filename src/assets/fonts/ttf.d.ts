// TTF files are imported as Data modules (see the [[rules]] entry in
// wrangler.toml), so the default export is the file's bytes.
declare module "*.ttf" {
    const data: ArrayBuffer;
    export default data;
}
