import {
  completeAnyWord,
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { EditorState, type Extension } from "@codemirror/state";

/** Suggest words that already appear in the file. */
export const wordCompletion: Extension = EditorState.languageData.of(() => [
  { autocomplete: completeAnyWord },
]);

const s = (template: string, label: string, detail: string): Completion =>
  snippetCompletion(template, { label, detail, type: "snippet", boost: -1 });

const PHP: Completion[] = [
  s("foreach (${items} as ${item}) {\n\t${}\n}", "foreach", "loop"),
  s(
    "foreach (${items} as ${key} => ${value}) {\n\t${}\n}",
    "foreachkv",
    "loop with keys",
  ),
  s("if (${condition}) {\n\t${}\n}", "if", "block"),
  s("if (${condition}) {\n\t${}\n} else {\n\t\n}", "ifelse", "block"),
  s("function ${name}(${params}) {\n\t${}\n}", "function", "definition"),
  s(
    "try {\n\t${}\n} catch (\\\\Throwable ${e}) {\n\t\n}",
    "try",
    "try / catch",
  ),
  s("echo esc_html( ${value} );", "echoesc", "escaped echo"),
  s("add_action( '${hook}', '${callback}' );", "add_action", "WordPress hook"),
  s(
    "add_filter( '${hook}', '${callback}' );",
    "add_filter",
    "WordPress filter",
  ),
  s(
    "add_action( 'wp_enqueue_scripts', function () {\n\twp_enqueue_style( '${handle}', get_stylesheet_directory_uri() . '/${path}', [], '${version}' );\n} );",
    "enqueue_style",
    "WordPress",
  ),
  s(
    "add_action( 'wp_enqueue_scripts', function () {\n\twp_enqueue_script( '${handle}', get_stylesheet_directory_uri() . '/${path}', [], '${version}', true );\n} );",
    "enqueue_script",
    "WordPress",
  ),
  s(
    "$${query} = new WP_Query( [\n\t'post_type' => '${post}',\n\t'posts_per_page' => ${10},\n] );\nwhile ( $${query}->have_posts() ) {\n\t$${query}->the_post();\n\t${}\n}\nwp_reset_postdata();",
    "wp_query",
    "WordPress loop",
  ),
  s(
    "if ( have_posts() ) :\n\twhile ( have_posts() ) :\n\t\tthe_post();\n\t\t${}\n\tendwhile;\nendif;",
    "the_loop",
    "WordPress loop",
  ),
  s(
    "get_template_part( '${slug}', '${name}' );",
    "get_template_part",
    "WordPress",
  ),
  s("<?php ${} ?>", "php", "tag"),
];

const JS: Completion[] = [
  s("for (const ${item} of ${items}) {\n\t${}\n}", "forof", "loop"),
  s("if (${condition}) {\n\t${}\n}", "if", "block"),
  s("function ${name}(${params}) {\n\t${}\n}", "function", "definition"),
  s("const ${name} = (${params}) => {\n\t${}\n};", "arrow", "arrow function"),
  s("try {\n\t${}\n} catch (${error}) {\n\t\n}", "try", "try / catch"),
  s("console.log(${});", "log", "console.log"),
  s("document.querySelector('${selector}')", "qs", "querySelector"),
  s(
    "document.addEventListener('DOMContentLoaded', () => {\n\t${}\n});",
    "ready",
    "DOM ready",
  ),
  s(
    "${el}.addEventListener('${click}', (${event}) => {\n\t${}\n});",
    "listener",
    "addEventListener",
  ),
  s(
    "const response = await fetch(${url});\nconst ${data} = await response.json();",
    "fetchjson",
    "fetch JSON",
  ),
];

const CSS: Completion[] = [
  s(
    "display: flex;\nalign-items: ${center};\njustify-content: ${center};",
    "flexcenter",
    "flex",
  ),
  s(
    "display: grid;\ngrid-template-columns: repeat(${3}, 1fr);\ngap: ${1rem};",
    "grid",
    "grid",
  ),
  s("@media (max-width: ${768px}) {\n\t${}\n}", "media", "media query"),
  s("transition: ${all} ${0.2s} ${ease};", "transition", "property"),
];

const SCSS: Completion[] = [
  ...CSS,
  s("@mixin ${name}(${args}) {\n\t${}\n}", "mixin", "SCSS"),
  s("@include ${name};", "include", "SCSS"),
  s("@use '${module}';", "use", "SCSS"),
  s("&:hover {\n\t${}\n}", "hover", "nested"),
];

const LESS: Completion[] = [
  ...CSS,
  s(".${mixin}() {\n\t${}\n}", "mixin", "Less"),
  s("&:hover {\n\t${}\n}", "hover", "nested"),
];

const HTML: Completion[] = [
  s(
    '<!doctype html>\n<html lang="${en}">\n<head>\n\t<meta charset="utf-8">\n\t<meta name="viewport" content="width=device-width, initial-scale=1">\n\t<title>${title}</title>\n</head>\n<body>\n\t${}\n</body>\n</html>',
    "html5",
    "document",
  ),
  s('<a href="${url}">${text}</a>', "link", "anchor"),
  s('<img src="${src}" alt="${alt}">', "img", "image"),
];

function snippetsFor(path: string): Completion[] {
  const ext = path.toLowerCase().slice(path.lastIndexOf(".") + 1);
  switch (ext) {
    case "php":
    case "phtml":
      return PHP;
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
    case "ts":
    case "tsx":
      return JS;
    case "css":
      return CSS;
    case "scss":
    case "sass":
      return SCSS;
    case "less":
      return LESS;
    case "html":
    case "htm":
      return HTML;
    default:
      return [];
  }
}

/** Built-in snippets for the file's language. */
export function snippetsExtension(path: string): Extension {
  const options = snippetsFor(path);
  if (!options.length) return [];
  const source = (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/[\w$]+/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    return { from: word.from, options, validFor: /^[\w$]*$/ };
  };
  return EditorState.languageData.of(() => [{ autocomplete: source }]);
}
