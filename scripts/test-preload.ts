// bun test does not execute package.json scripts, so the smoke-test pattern
// (NO_FILE_LOG=1 on the script) never applies to the command people actually run.
// The logger chooses a file transport when this module is first imported.
process.env.NO_FILE_LOG = '1';
