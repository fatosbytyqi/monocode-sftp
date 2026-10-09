//! Code intelligence for the editor: language servers, SCSS/Less compiling
//! (AI inline completions run in the frontend through Claude Code). Each part is switched on in Settings → Code Editor.

pub mod compile;
pub mod lsp;
pub mod tools;
