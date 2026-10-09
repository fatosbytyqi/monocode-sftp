//! Code intelligence for the editor: language servers, SCSS/Less compiling
//! and AI inline completions. Each part is switched on in Settings → Code Editor.

pub mod ai;
pub mod compile;
pub mod lsp;
pub mod tools;
