import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const allowances = {
  "cli.ts": { streams: 3, encodes: 2 },
  "core/auth.ts": { streams: 1 },
  "core/profiles.ts": { streams: 1 },
  "core/transport.ts": { streams: 1 },
  "core/errors.ts": { encodes: 2 },
  "core/output.ts": { encodes: 2 },
  "domains/host/index.ts": { encodes: 4 },
};

export function checkOutput(sources) {
  const errors = [];
  for (const [name, text] of sources) {
    const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
    const allowed = allowances[name] ?? {};
    let streams = 0;
    let encodes = 0;
    function visit(node) {
      if (ts.isIdentifier(node) && node.text === "console") errors.push(`${name}: console output`);
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "process" && ["stdout", "stderr"].includes(node.name.text)) streams++;
      if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === "@toon-format/toon") {
        const bindings = node.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings) || bindings.elements.some((element) => element.name.text !== "encode" || element.propertyName)) errors.push(`${name}: unsupported TOON import`);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "encode") encodes++;
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (streams > (allowed.streams ?? 0)) errors.push(`${name}: unapproved process stream`);
    if (encodes > (allowed.encodes ?? 0)) errors.push(`${name}: unapproved TOON encode`);
  }
  return errors;
}

function sources(dir, root = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path, root) : path.endsWith(".ts") ? [[relative(root, path), readFileSync(path, "utf8")]] : [];
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = checkOutput(sources(join(dirname(fileURLToPath(import.meta.url)), "../src")));
  if (errors.length) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
  }
}
